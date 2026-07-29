import { invoke } from '@tauri-apps/api/core'

import { IS_TAURI } from '@/lib/platform'

// Secure credential storage (D1). Isolates the OS keystore behind a small typed
// API so the rest of the app never touches the plugin directly. Silent (no
// biometric prompt) — the session token/password aren't kept in plaintext.
//
// Backed by charlesportwoodii/tauri-plugin-keyring (keyring-core 1.0): Android
// SharedPreferences encrypted by the Android Keystore, iOS/macOS Keychain,
// Windows Credential Manager, Linux Secret Service. Its JS bindings aren't on npm
// under this name (the published `tauri-plugin-keyring-api` is a different, broken
// plugin), so the thin `invoke('plugin:keyring|…')` layer is vendored here — it
// mirrors the plugin's guest-js/index.ts exactly.
//
// FIXME(D): storage is silent; if we later want biometric-gated retrieval, wrap
// these reads with tauri-plugin-biometric authenticate() first.

const SERVICE = 'hermes'

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
type SecretKey =
  | 'token'
  | 'password'
  | 'cookies'
  | 'sshKey'
  | 'sshPassphrase'
  | 'sshPassword'
  | 'installationId'

// The plugin's service name is set once per process (a Rust OnceLock), so init is
// memoized. On failure the cached promise is cleared so a later call can retry.
let initPromise: Promise<void> | null = null

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = invoke<void>('plugin:keyring|initialize_keyring', { serviceName: SERVICE }).catch(err => {
      initPromise = null
      throw err
    })
  }

  return initPromise
}

async function kHas(username: SecretKey): Promise<boolean> {
  await ensureInit()

  return invoke<boolean>('plugin:keyring|has_password', { username })
}

// get_password rejects when the entry is missing, so gate on has_password and
// return null for "not set" (matching the old contract).
async function kGet(username: SecretKey): Promise<string | null> {
  await ensureInit()

  if (!(await kHas(username))) {
    return null
  }

  return invoke<string>('plugin:keyring|get_password', { username })
}

async function writeKey(key: SecretKey, value: string | undefined): Promise<void> {
  await ensureInit()

  if (value) {
    await invoke<void>('plugin:keyring|set_password', { username: key, password: value })
  } else {
    await invoke<void>('plugin:keyring|delete_password', { username: key }).catch(() => {})
  }
}

// Keystore calls reject when there is no Tauri runtime (browser dev / vitest) or
// no keystore available; treat any failure as "unavailable" so callers degrade to
// no-persistence rather than crashing (never fall back to plaintext).
//
// D6: gated on IS_TAURI (any native target) rather than IS_MOBILE — the vendored
// keyring plugin also backs desktop (Linux Secret Service / macOS Keychain /
// Windows Credential Manager), so OAuth/cloud sessions now persist on desktop too.
// A missing Secret Service daemon on Linux simply throws → caught → no-persistence.
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

/** True when the OS keystore is reachable (mobile + a successful probe). */
export async function secureStoreAvailable(): Promise<boolean> {
  return safe(async () => {
    await kHas('token') // reachable if this resolves

    return true
  }, false)
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
export async function clearSecrets(): Promise<void> {
  await safe(async () => {
    await writeKey('token', undefined)
    await writeKey('password', undefined)
    await writeKey('cookies', undefined)
    await writeKey('sshKey', undefined)
    await writeKey('sshPassphrase', undefined)
    await writeKey('sshPassword', undefined)

    return undefined
  }, undefined)
}

/** SSH credentials, kept apart from {@link Secrets} because they belong to a
 *  connection target rather than to the gateway login form. */
export interface SshSecrets {
  privateKeyPem?: string
  passphrase?: string
  password?: string
}

/** Persist SSH credentials. Returns false when the keystore is unavailable. */
export async function saveSshSecrets(secrets: SshSecrets): Promise<boolean> {
  return safe(async () => {
    await writeKey('sshKey', secrets.privateKeyPem)
    await writeKey('sshPassphrase', secrets.passphrase)
    await writeKey('sshPassword', secrets.password)

    return true
  }, false)
}

/** Read SSH credentials; every field is optional. */
export async function loadSshSecrets(): Promise<SshSecrets> {
  return safe<SshSecrets>(
    async () => {
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
    },
    {}
  )
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
  return safe(async () => kGet('cookies'), null)
}
