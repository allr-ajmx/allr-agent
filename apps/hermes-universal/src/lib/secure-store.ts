import { invoke } from '@tauri-apps/api/core'

import { IS_TAURI } from '@/lib/platform'

// Secure credential storage (D1). Isolates the OS keystore behind a small typed
// API so the rest of the app never touches storage directly.
//
// Backed by src-tauri/src/secrets/, which drives keyring-core itself: Android
// Keystore, iOS/macOS Keychain, Windows Credential Manager, Linux Secret Service.
//
// This used to invoke a vendored `tauri-plugin-keyring` through raw
// `plugin:keyring|…` strings, whose commands took the account name as an
// arbitrary string — so any window in the capability's globs could read any
// entry, including the OAuth bearer/refresh sets Rust owns. The `key` below is
// now a Rust enum, and there is no generic credential command left to call.
//
// FIXME(D): storage is still silent (no device-unlock prompt). The gate lands on
// top of these calls, in the same Rust module.

export interface Secrets {
  token?: string
  password?: string
}

// The keystore keys one credential per username under the shared service. We keep
// token and password as two named entries; `cookies` holds the serialized gateway
// session jar (R2b) so an OAuth/cloud login survives an app restart.
// `sshKey`/`sshPassphrase`/`sshPassword` back SSH gateway mode. On mobile the
// pasted PEM is the ONLY way in — neither Android nor iOS offers a file picker
// russh can read a private key through — so it is stored here and passed to Rust
// over IPC, never written to disk. `installationId` is not a secret but lives
// here for durability: see store/installation-id.ts for why losing it orphans
// remote backends.
type SecretKey = 'token' | 'password' | 'cookies' | 'sshKey' | 'sshPassphrase' | 'sshPassword' | 'installationId'

// One round trip, and a missing entry is null rather than a rejection. This was
// `has_password` then `get_password` — two IPC hops and a window in which the
// answer could change between them, for no gain: "not there" is exactly what the
// store's own NoEntry means.
//
// An empty string reads back as "nothing set", not as a credential. Rust treats
// a blank write as a delete for the same reason: a stored `''` would come back
// looking like a real, wrong credential.
async function kGet(key: SecretKey): Promise<string | null> {
  const value = await invoke<null | string>('secrets_get', { key })

  return value || null
}

/** Write a value, or delete the entry when there is none. */
async function writeKey(key: SecretKey, value: string | undefined): Promise<void> {
  await invoke<void>('secrets_set', { key, value: value ?? '' })
}

// Keystore calls reject when there is no Tauri runtime (browser dev / vitest) or
// no keystore available; treat any failure as "unavailable" so callers degrade to
// no-persistence rather than crashing (never fall back to plaintext).
//
// D6: gated on IS_TAURI (any native target) rather than IS_MOBILE — the store
// backs desktop too (Linux Secret Service / macOS Keychain / Windows Credential
// Manager), so OAuth/cloud sessions persist there as well. A missing Secret
// Service daemon on Linux simply throws → caught → no-persistence.
async function safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  if (!IS_TAURI) {
    return fallback
  }

  try {
    return await op()
  } catch {
    return fallback
  }
}

/** What the credential store can do on this device. */
export interface SecureStoreStatus {
  /** Whether credentials can be persisted at all. */
  available: boolean
  /** Why not, when they cannot. */
  reason?: string
  /** Whether this device has an unlock method (biometric or passcode). */
  gateAvailable: boolean
  /** Whether reads currently require one. Off until every platform has a gate. */
  gateEnforced: boolean
  /** Whether an unlock lease is open right now. */
  unlocked: boolean
  /**
   * Whether this build is why macOS keeps asking for the keychain password.
   *
   * True only for an ad-hoc signed macOS bundle. Such a build has no code
   * identity a keychain ACL can bind to, so every credential read and write
   * re-prompts and "Always Allow" cannot make it stop. Nothing the app does at
   * runtime changes it — surfaced so the UI can explain the prompts rather than
   * leaving the user to conclude the app is broken.
   */
  adHocSigned: boolean
}

const UNAVAILABLE: SecureStoreStatus = {
  available: false,
  gateAvailable: false,
  gateEnforced: false,
  unlocked: false,
  adHocSigned: false
}

export async function secureStoreStatus(): Promise<SecureStoreStatus> {
  return safe(async () => invoke<SecureStoreStatus>('secrets_status'), UNAVAILABLE)
}

/** True when the OS keystore is reachable and we can actually persist. */
export async function secureStoreAvailable(): Promise<boolean> {
  return (await secureStoreStatus()).available
}

/** Why storage is unavailable, when it is — null when it works.
 *
 *  Worth surfacing rather than failing silently: on a Linux box with no Secret
 *  Service running we deliberately store NOTHING, and "your password was not
 *  saved" is only actionable with the reason attached. */
export async function secureStoreUnavailableReason(): Promise<null | string> {
  const status = await secureStoreStatus()

  return status.available ? null : (status.reason ?? 'no OS credential store is available')
}

/**
 * Prove the device owner is present, opening a read lease.
 *
 * Safe to call unconditionally: it is a no-op when a lease is already open, and
 * when the gate is not enforced. Resolves false when the user declined or the
 * device has no unlock method — callers should surface that as "unlock to
 * continue", never as a credential failure.
 *
 * One unlock covers a whole connect. An SSH dial reads the PEM, the passphrase
 * and the password, so a per-read prompt would fire three dialogs for one action.
 */
export async function unlockSecrets(reason?: string): Promise<boolean> {
  return safe(async () => {
    await invoke<void>('secrets_unlock', { reason: reason ?? null })

    return true
  }, false)
}

/** End the lease now. Rust also does this on background/suspend. */
export async function lockSecrets(): Promise<void> {
  await safe(async () => invoke<void>('secrets_lock'), undefined)
}

/**
 * Open a lease if this device needs one, before reading credentials.
 *
 * Every credential read goes through here, which is what makes the boot restore
 * work: it reads the saved SSH secrets on launch, so the unlock prompt appears
 * exactly once, at exactly the moment the credentials are actually wanted —
 * rather than as a dialog in front of app startup that has to explain itself.
 *
 * Without it a gated device would read nothing and report an SSH auth failure,
 * sending the user to check their key when what actually happened is that
 * nobody had unlocked the machine. One call per read group, not per key: a
 * connect wants the PEM, the passphrase and the password together.
 */
async function ensureUnlocked(): Promise<void> {
  const status = await secureStoreStatus()

  if (!status.available || !status.gateEnforced || !status.gateAvailable || status.unlocked) {
    return
  }

  await invoke<void>('secrets_unlock', { reason: null })
}

/** Persist secrets. Returns false if the keystore is unavailable (nothing stored). */
export async function saveSecrets(secrets: Secrets): Promise<boolean> {
  return safe(async () => {
    await writeKey('token', secrets.token)
    await writeKey('password', secrets.password)

    return true
  }, false)
}

/** Read secrets, or null when the keystore is unavailable / nothing saved. */
export async function loadSecrets(): Promise<Secrets | null> {
  return safe(async () => {
    await ensureUnlocked()

    const [token, password] = await Promise.all([kGet('token'), kGet('password')])

    if (!token && !password) {
      return null
    }

    return { token: token ?? undefined, password: password ?? undefined }
  }, null)
}

/** Remove all stored secrets (e.g. on disconnect/forget).
 *
 *  Deliberately does NOT clear `installationId`: it is an identity, not a
 *  credential, and dropping it would orphan any remote backend this install
 *  owns (see store/installation-id.ts). */
export async function clearSecrets(): Promise<boolean> {
  return safe(async () => {
    // One command, so a partial wipe cannot be reported as a clean one. This
    // used to be six deletes behind a `safe(…, undefined)` that swallowed every
    // failure — meaning the one operation whose entire job is "the credential is
    // gone" could not tell you when it was not.
    await invoke<void>('secrets_clear')

    return true
  }, false)
}

/** SSH credentials, kept apart from {@link Secrets} because they belong to a
 *  connection target rather than to the gateway login form. */
export interface SshSecrets {
  privateKeyPem?: string
  passphrase?: string
  password?: string
}

/** Persist SSH credentials, leaving out whatever `patch` does not mention.
 *
 *  Deliberately the only writer, and deliberately a merge. A write-all-three
 *  variant used to exist and was the natural thing to call, which made it easy
 *  to wipe the password by saving the two fields the connection form owns — and
 *  the password is not one of them. It only ever arrives as the answer to a
 *  prompt Rust raised mid-connect, so a clobbering save destroyed the one
 *  credential an unattended restore had to work with.
 *
 *  An undefined field means "leave as-is"; pass an empty string to clear one. */
export async function mergeSshSecrets(patch: SshSecrets): Promise<boolean> {
  return safe(async () => {
    if (patch.privateKeyPem !== undefined) {
      await writeKey('sshKey', patch.privateKeyPem)
    }

    if (patch.passphrase !== undefined) {
      await writeKey('sshPassphrase', patch.passphrase)
    }

    if (patch.password !== undefined) {
      await writeKey('sshPassword', patch.password)
    }

    return true
  }, false)
}

/** Read SSH credentials; every field is optional.
 *
 *  Every absent field is `undefined`, never `''`. That distinction is load-
 *  bearing on the Rust side: `Some("")` is a real value there, and an empty
 *  passphrase in particular makes russh attempt a decrypt instead of reporting
 *  that the key needs one — which silently discarded every encrypted key.
 *  `kGet` collapses blank to null, so it cannot come back from here. */
export async function loadSshSecrets(): Promise<SshSecrets> {
  return safe<SshSecrets>(async () => {
    await ensureUnlocked()

    const [privateKeyPem, passphrase, password] = await Promise.all([
      kGet('sshKey'),
      kGet('sshPassphrase'),
      kGet('sshPassword')
    ])

    return {
      privateKeyPem: privateKeyPem ?? undefined,
      passphrase: passphrase ?? undefined,
      password: password ?? undefined
    }
  }, {})
}

/** Read this install's stable id, or null when unset/unavailable. */
export async function loadInstallationId(): Promise<string | null> {
  return safe(async () => kGet('installationId'), null)
}

/** Persist this install's stable id. */
export async function saveInstallationId(id: string): Promise<boolean> {
  return safe(async () => {
    await writeKey('installationId', id)

    return true
  }, false)
}

/**
 * Persist the serialized gateway session cookie jar (R2b). Kept separate from
 * {@link saveSecrets} because it round-trips through the Rust transport
 * (`cookies_export`/`cookies_import`), not the connection form.
 */
export async function saveSessionCookies(json: string): Promise<boolean> {
  return safe(async () => {
    await writeKey('cookies', json)

    return true
  }, false)
}

/** Read the persisted cookie jar blob, or null when unavailable / none saved. */
export async function loadSessionCookies(): Promise<string | null> {
  return safe(async () => {
    await ensureUnlocked()

    return kGet('cookies')
  }, null)
}
