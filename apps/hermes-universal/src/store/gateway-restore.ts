import { oauthStatus } from '@/lib/auth'
import { loadString, removeKey, saveString } from '@/lib/persist'
import { atom } from '@/store/atom'
import {
  connect,
  connectCloud,
  connectLocal,
  connectSsh,
  disconnect,
  loadSavedLogin,
  type SshTarget
} from '@/store/connection'
import type { GatewayMode } from '@/store/gateway-config'
import { $gatewayMode } from '@/store/gateway-switch'

// Auto-connect on restart (D8). The live connection ($connection/$connectionPhase)
// is memory-only, so without this the app always cold-boots to the connect screen
// even though the session cookies (jar blob) + secrets (keyring) survived. Here we
// persist the LAST successful connection *target* (non-secret; the secrets stay in
// the keyring, the cookies in the Rust jar) and, on boot, re-dial it.
//
// Desktop restores its last-applied connection in the Electron main process
// (startHermes reads the saved config); universal has no main process, so the
// renderer owns the restore. Mirrors desktop's "auto-reconnect to the last
// gateway" behaviour across all three modes.

const TARGET_KEY = 'hermes.connection.last'

/** The last successful connection, enough to re-dial it. Non-secret only —
 *  token/password live in the OS keyring, the session cookie jar in Rust. */
export interface GatewayTarget {
  mode: GatewayMode
  /** remote: the backend URL + (optional) username for the password path. */
  url?: string
  username?: string
  /** local: the profile the backend was spawned with. */
  profile?: null | string
  /** cloud: the discovered agent's gateway URL + id/name (for the restore label). */
  cloudBaseUrl?: string
  cloudAgentId?: string
  cloudAgentName?: string
  /** ssh: the connection target. Non-secret only — the key/passphrase/password
   *  live in the keyring (see lib/secure-store). */
  ssh?: SshTarget
}

// Another whitelist that must grow with the union: a saved target whose mode is
// not listed here is rejected as malformed, and the auto-reconnect silently
// does not happen.
function isMode(value: unknown): value is GatewayMode {
  return value === 'local' || value === 'remote' || value === 'cloud' || value === 'ssh'
}

/** Persist the target of a just-established connection (best-effort). */
export function saveGatewayTarget(target: GatewayTarget): void {
  try {
    saveString(TARGET_KEY, JSON.stringify(target))
  } catch {
    // storage disabled — non-fatal (auto-connect simply won't happen next launch)
  }
}

/** Read the saved target, or null when absent/malformed. */
export function loadGatewayTarget(): GatewayTarget | null {
  const raw = loadString(TARGET_KEY)

  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as GatewayTarget

    return isMode(parsed?.mode) ? parsed : null
  } catch {
    return null
  }
}

/** Forget the saved target (an explicit "use a different gateway" / reset). */
export function clearGatewayTarget(): void {
  removeKey(TARGET_KEY)
}

// --- Android OAuth resume marker --------------------------------------------------
// On Android the OAuth sign-in navigates the MAIN webview to the gateway login and back
// (a second window can't be dismissed there — see src-tauri/src/oauth.rs), which reloads
// the SPA and destroys the JS mid-connect. We stash the connect intent here BEFORE
// navigating away so the fresh boot can finish it (the Rust cookie jar is in-memory and
// survives the reload). localStorage is per-origin and the app origin is unchanged across
// the round-trip, so the marker survives. One-shot: the resume reads-and-clears it.

const PENDING_OAUTH_KEY = 'hermes.oauth.pending'

export interface PendingOAuth {
  base: string
  provider?: string
  username?: string
}

/** Queue an OAuth resume for the next boot (best-effort). Android only. */
export function savePendingOAuth(pending: PendingOAuth): void {
  try {
    saveString(PENDING_OAUTH_KEY, JSON.stringify(pending))
  } catch {
    // storage disabled — resume simply won't fire (the user taps sign-in again).
  }
}

/** Read AND clear the pending marker (one-shot), or null when absent/malformed. */
export function takePendingOAuth(): PendingOAuth | null {
  const raw = loadString(PENDING_OAUTH_KEY)
  removeKey(PENDING_OAUTH_KEY)

  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as PendingOAuth

    return typeof parsed?.base === 'string' && parsed.base ? parsed : null
  } catch {
    return null
  }
}

/** Whether an OAuth resume is queued — read synchronously to seed `$restoring`. */
export function hasPendingOAuth(): boolean {
  return Boolean(loadString(PENDING_OAUTH_KEY))
}

/** Whether a restorable connection exists — read synchronously at module load so
 *  the very first paint can show the connecting screen instead of the picker. */
export function hasSavedTarget(): boolean {
  return loadGatewayTarget() !== null
}

/**
 * True while the boot-time auto-connect is dialing. Seeded synchronously from the saved
 * target — or a pending Android OAuth resume — so `MobileController` shows the connecting
 * screen (not the connect picker) on the very first render when a restore is pending.
 */
export const $restoring = atom(hasSavedTarget() || hasPendingOAuth())

/**
 * "Use a different gateway": abandon the restore and land on the connect picker.
 * Clears `$restoring` and tears down any in-flight dial (disconnect() also drops
 * `$hasConnected`, so the root gate falls to the picker rather than looping back
 * to the connecting screen). The saved target is left intact (a later successful
 * connect overwrites it); the picker opens on the saved mode.
 */
export function cancelRestore(): void {
  $restoring.set(false)
  disconnect()
}

/**
 * Re-dial the last successful connection on app launch. Reads the saved target,
 * pulls secrets from the keyring (the cookie jar is already rehydrated by
 * `restoreSessionCookies()`), and drives the matching connect. On failure it
 * leaves `$connectionError` set and clears `$restoring`, so the connect screen
 * surfaces the error with prefilled fields. No-op (and clears `$restoring`) when
 * there is no saved target — a genuine first run.
 */
export async function autoRestoreConnection(): Promise<void> {
  // Android OAuth resume: the sign-in navigated the main webview away and back, reloading
  // us here. The Rust cookie jar (in-memory, survives the reload) now holds the session,
  // so confirm it and finish the connect WITHOUT re-opening the login. The signedIn
  // pre-check keeps a cancelled/expired login from re-navigating into a loop — it just
  // falls through to the normal restore / connect screen (the marker is already cleared).
  const pending = takePendingOAuth()

  if (pending) {
    const status = await oauthStatus(pending.base).catch(() => ({ signedIn: false }))

    if (status.signedIn) {
      $gatewayMode.set('remote')

      try {
        await connect({ url: pending.base, username: pending.username })
      } catch {
        // connect() already set $connectionError + phase; connect screen surfaces it.
      } finally {
        $restoring.set(false)
      }

      return
    }
  }

  const target = loadGatewayTarget()

  if (!target) {
    $restoring.set(false)

    return
  }

  // Reopen into the saved mode so a failed restore lands on the right connect surface.
  $gatewayMode.set(target.mode)

  try {
    if (target.mode === 'local') {
      await connectLocal(target.profile ?? null)
    } else if (target.mode === 'ssh') {
      if (!target.ssh?.host?.trim()) {
        throw new Error('No saved SSH host to reconnect to')
      }

      // Non-interactive: this runs before any UI is mounted, so Rust must fail
      // fast on a passphrase rather than block on a dialog nobody can answer.
      await connectSsh({ ...target.ssh, profile: target.profile ?? null }, { interactive: false })
    } else if (target.mode === 'cloud') {
      if (!target.cloudBaseUrl) {
        throw new Error('No saved Hermes Cloud agent to reconnect to')
      }

      await connectCloud(target.cloudBaseUrl, target.profile ?? null)
    } else {
      if (!target.url?.trim()) {
        throw new Error('No saved gateway URL to reconnect to')
      }

      const saved = await loadSavedLogin().catch(() => null)
      await connect({
        url: target.url,
        username: target.username || undefined,
        token: saved?.token || undefined,
        password: saved?.password || undefined
      })
    }
  } catch {
    // connect*/connectLocal/connectCloud already set $connectionError + phase; the
    // connect screen takes over once $restoring clears below.
  } finally {
    $restoring.set(false)
  }
}
