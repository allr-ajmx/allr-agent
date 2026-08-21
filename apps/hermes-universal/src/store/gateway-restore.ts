import { isGatewayReauthRequired } from '@/gateway'
import { oauthStatus } from '@/lib/auth'
import { loadString, removeKey, saveString } from '@/lib/persist'
import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'
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
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'

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

/**
 * How many times the boot restore re-dials before giving up on the connect screen.
 *
 * Bounded for the same reason the supervisor's auth budget is (store/connection.ts):
 * a restore that can never succeed must end somewhere the user can act, not in a
 * permanent spinner. Three attempts with full-jitter backoff covers the launch-time
 * transients — radio not up, DNS unsettled, gateway mid-restart — without making a
 * genuinely unreachable gateway take noticeably longer to report.
 */
const MAX_RESTORE_ATTEMPTS = 3

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

// --- Mobile OAuth resume marker -----------------------------------------------------
// On Android AND iOS an interactive sign-in navigates the CALLING webview to the login
// page and back (neither phone can host a dismissable second window — see
// src-tauri/src/oauth.rs), which reloads the SPA and destroys the JS mid-connect. We
// stash the connect intent here BEFORE navigating away so the fresh boot can finish it
// (the session outlives the reload either way — the RFC 8252 bearer in the OS keyring,
// or the gateway cookies in Rust's in-memory jar). localStorage is per-origin
// and the app origin is unchanged across the round-trip, so the marker survives.
// One-shot: the resume reads-and-clears it. The portal (Nous Cloud) login does the same
// round-trip and gets its own marker below.

const PENDING_OAUTH_KEY = 'hermes.oauth.pending'

export interface PendingOAuth {
  base: string
  provider?: string
  username?: string
}

/** Queue an OAuth resume for the next boot (best-effort). Mobile only. */
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

// The portal (Nous Cloud) equivalent. It carries no payload — the portal session is a
// single global thing, so all the reload needs to know is "you were in the middle of
// signing in to the portal", which puts the gateway panel back on the cloud card instead
// of dropping the user on whatever mode was persisted.
const PENDING_PORTAL_KEY = 'hermes.portal.pending'

/** Queue a portal-sign-in resume for the next boot (best-effort). Mobile only. */
export function savePendingPortal(): void {
  try {
    saveString(PENDING_PORTAL_KEY, '1')
  } catch {
    // storage disabled — the user just lands on the gateway panel and taps again.
  }
}

/** Read AND clear the portal marker (one-shot). */
export function takePendingPortal(): boolean {
  const raw = loadString(PENDING_PORTAL_KEY)
  removeKey(PENDING_PORTAL_KEY)

  return Boolean(raw)
}

/** Whether a restorable connection exists — read synchronously at module load so
 *  the very first paint can show the connecting screen instead of the picker. */
export function hasSavedTarget(): boolean {
  return loadGatewayTarget() !== null
}

/**
 * True while the boot-time auto-connect is dialing. Seeded synchronously from the saved
 * target — or a pending mobile OAuth resume — so `MobileController` shows the connecting
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
 * Dial a saved `GatewayTarget`, pulling any secret it needs from the keyring.
 *
 * The one place that knows how to turn a persisted target back into a live
 * connection, for all four modes. Three callers share it: the boot restore below,
 * the rollback of a failed gateway switch, and a follower WebView re-homing onto
 * the gateway another WebView just switched to (store/gateway-switch-sync.ts).
 *
 * Sets `$gatewayMode` from the target, so a failed dial lands on the right connect
 * surface and a rollback puts the mode selection back where it was.
 *
 * Non-interactive by default: at boot no UI is mounted yet, so Rust must fail fast
 * on an SSH passphrase rather than block on a dialog nobody can answer — and a
 * follower must never raise a second prompt for a dial the user drove elsewhere.
 *
 * Throws whatever the underlying connect threw; those helpers have already set
 * `$connectionError` and the phase.
 */
export async function dialSavedTarget(target: GatewayTarget, interactive = false): Promise<void> {
  $gatewayMode.set(target.mode)

  if (target.mode === 'local') {
    await connectLocal(target.profile ?? null)
  } else if (target.mode === 'ssh') {
    if (!target.ssh?.host?.trim()) {
      throw new Error('No saved SSH host to reconnect to')
    }

    await connectSsh({ ...target.ssh, profile: target.profile ?? null }, { interactive })
  } else if (target.mode === 'cloud') {
    if (!target.cloudBaseUrl) {
      throw new Error('No saved Nous Cloud agent to reconnect to')
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
  // Mobile OAuth resume: the sign-in navigated the calling webview away and back,
  // reloading us here. Rust now holds the session — either the RFC 8252 bearer in the OS
  // keyring, or the gateway cookies in the in-memory reqwest jar, depending on which flow
  // ran. `oauthStatus` answers for both (it reads the keyring first, then probes
  // /api/auth/me), so this does not have to know which. Confirm and finish the connect
  // WITHOUT re-opening the login. The signedIn pre-check keeps a cancelled/expired login
  // from re-navigating into a loop — it just falls through to the normal restore /
  // connect screen (the marker is already cleared).
  const pending = takePendingOAuth()

  if (pending) {
    const status = await oauthStatus(pending.base).catch(() => ({ signedIn: false }))

    if (status.signedIn) {
      $gatewayMode.set('remote')

      try {
        await connect({ url: pending.base, username: pending.username })
        // Only the ONE WebView the sign-in navigated came back on the new gateway — and
        // it need not be the shell: on Android, Settings runs in its own activity, so a
        // switch driven from there leaves MainActivity serving the gateway we just left.
        // This is the same broadcast the configurator makes for a switch that completed
        // without a round-trip (the resume can't use it — the navigation destroyed that
        // JS context mid-`softSwitchGateway`).
        const target = loadGatewayTarget()

        if (target) {
          broadcastGatewaySwitch('remote', target)
        }
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

  // Reopen into the saved mode so a failed restore lands on the right connect
  // surface — dialSavedTarget commits it.
  //
  // Bounded ladder rather than a single shot. One transient failure at launch used
  // to be terminal: the dial's catch nulls `$connection`, so the reconnect
  // supervisor (which requires a live connection) never armed, and with
  // `$hasConnected` false on a fresh process MobileController fell through to the
  // CONNECT screen — indistinguishable from being signed out, even though tapping
  // Connect immediately afterwards worked. A phone has plenty of ways to fail the
  // first dial and none of them mean the session is gone: the radio may not be up
  // microseconds after launch, DNS may not have settled, the gateway may be mid
  // restart.
  //
  // `$restoring` is held true across the whole ladder so the user watches the
  // connecting screen — which reveals the inline configurator once
  // `$connectionError` is published — instead of the connect picker.
  for (let attempt = 0; attempt < MAX_RESTORE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, reconnectBackoffDelayMs(attempt - 1)))
    }

    try {
      await dialSavedTarget(target)
      $restoring.set(false)

      return
    } catch (err) {
      // A refused CREDENTIAL is not transient — asking again cannot change the
      // answer — so it spends the ladder immediately rather than sitting behind
      // three backoffs the user has to watch. Everything else (refused, timeout,
      // DNS, a gateway still coming up) is exactly what the retries are for.
      if (isGatewayReauthRequired(err)) {
        break
      }
      // connect*/connectLocal/connectCloud already set $connectionError + phase; the
      // connect screen takes over once $restoring clears below.
    }
  }

  $restoring.set(false)
}
