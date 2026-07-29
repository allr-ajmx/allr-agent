import { isGatewayReauthRequired } from '@/gateway'
import {
  fetchAuthProviders,
  oauthLogin,
  oauthLogout,
  oauthStatus,
  passwordLogin,
  portalAgentSignIn,
  portalLogout
} from '@/lib/auth'
import { loadString, saveString } from '@/lib/persist'
import { IS_ANDROID } from '@/lib/platform'
import { clearSecrets, loadSecrets, loadSshSecrets, saveSecrets, type Secrets } from '@/lib/secure-store'
import { persistSessionCookies } from '@/lib/session-persist'
import { atom } from '@/store/atom'
import { $gatewayState, closeGateway, connectGateway } from '@/store/gateway'
import { chooseGatedAuth, type Connection } from '@/store/gateway-config'
import { saveGatewayTarget, savePendingOAuth } from '@/store/gateway-restore'
import { getInstallationId } from '@/store/installation-id'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import { connectSshBackend, disconnectSsh, newAttemptId, type SshConnectConfig } from '@/store/ssh-backend'
import { httpRequest } from '@/transport/http'

// AuthMode / Connection are now defined in store/gateway-config (the reconciled
// model incl. 'oauth' + gateway mode). Re-exported here so existing importers of
// '@/store/connection' keep working.
export type { AuthMode, Connection } from '@/store/gateway-config'

// The RemoteProvider: resolve a LAN/remote Hermes backend URL + auth, then hold
// the live connection descriptor. All chat traffic then runs over the gateway
// (store/gateway.ts). Remote only — no local-spawn mode on mobile.
//
// Two auth shapes:
//   • token / none  — loopback / non-gated backends (auth_required=false):
//                      WS uses ?token= (or nothing).
//   • ticket         — gated backends (auth_required=true): password-login sets a
//                      session cookie (held in Rust), and the WS uses a fresh
//                      single-use ?ticket= minted per connect (store/gateway.ts).

export type ConnectionPhase = 'idle' | 'probing' | 'connecting' | 'ready' | 'error'

export interface StatusInfo {
  version?: string
  auth_required?: boolean
  auth_providers?: string[]
  [key: string]: unknown
}

export interface ConnectInput {
  url: string
  token?: string
  username?: string
  password?: string
}

// Non-secret conveniences live in localStorage for a synchronous prefill; the
// secrets (token/password) live in the OS keyring (see @/lib/secure-store).
const URL_KEY = 'hermes.url'
const USER_KEY = 'hermes.username'

export const $connection = atom<Connection | null>(null)
export const $connectionPhase = atom<ConnectionPhase>('idle')
export const $connectionError = atom<string | null>(null)
export const $status = atom<StatusInfo | null>(null)

/**
 * True once a live connection has been reached in this session (until an explicit
 * disconnect). The root gate reads it so an in-session reconnect (a dropped socket
 * or a settings "Save & reconnect") shows the connecting screen over the mounted
 * shell/Settings instead of bouncing to the full-screen connect picker — the
 * picker is reserved for a genuine first run. Reset by `disconnect()` (deliberate
 * sign-out → back to the picker). Not persisted: a fresh launch starts false and
 * the boot restore (`$restoring`) drives the connecting screen instead.
 */
export const $hasConnected = atom(false)

export const lastUrl = (): string => loadString(URL_KEY)
export const lastUsername = (): string => loadString(USER_KEY)

/** Read the saved token/password from the keyring (silent; null if none). */
export function loadSavedLogin(): Promise<Secrets | null> {
  return loadSecrets()
}

/** Forget the saved secrets (e.g. a "sign out everywhere" affordance). */
export function forgetSavedLogin(): Promise<void> {
  return clearSecrets()
}

export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim()

  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`
  }

  return value.replace(/\/+$/, '')
}

/** Probe /api/status WITHOUT credentials to learn how the backend authenticates. */
export async function probeStatus(rawUrl: string): Promise<StatusInfo> {
  const base = normalizeBaseUrl(rawUrl)
  const res = await httpRequest('GET', `${base}/api/status`, { timeoutMs: 8000 })

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Backend responded HTTP ${res.status}`)
  }

  return JSON.parse(res.body) as StatusInfo
}

/**
 * Drive the interactive gateway OAuth sign-in.
 *
 * On desktop/iOS this opens a dedicated sign-in window and the promise resolves when the
 * session lands. On ANDROID the Rust command navigates the MAIN webview to the login and
 * back (a second window can't be dismissed there — see src-tauri/src/oauth.rs); that
 * navigation destroys this JS context, so `oauthLogin` never resolves here. We persist a
 * one-shot resume marker FIRST so the post-reload boot (`autoRestoreConnection`) finishes
 * the connect. Callers must treat this as "may never return" on Android.
 */
async function beginOAuthLogin(base: string, provider?: string, username?: string): Promise<void> {
  if (IS_ANDROID) {
    savePendingOAuth({ base, provider, username })
  }

  await oauthLogin(base, provider)
}

export async function connect(input: ConnectInput): Promise<void> {
  const base = normalizeBaseUrl(input.url)
  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('probing')

  try {
    const status = await probeStatus(base)
    $status.set(status)

    let conn: Connection
    let oauthProvider: string | undefined

    if (status.auth_required) {
      // Gated: pick the concrete path from the advertised providers. Password
      // login (→ ticket) wins only when the operator supplied credentials AND a
      // provider supports it; otherwise the interactive OAuth path.
      $connectionPhase.set('connecting')
      const providers = await fetchAuthProviders(base)
      const choice = chooseGatedAuth(providers, Boolean(input.username && input.password))

      if (choice.authMode === 'ticket') {
        if (!input.username || !input.password) {
          throw new Error('This backend requires a username and password')
        }

        // password-login sets the session cookie in Rust; the WS authorizes with
        // a per-connect ?ticket= (built in connectGateway).
        await passwordLogin(base, input.username, input.password, choice.provider)
        conn = { baseUrl: base, mode: 'remote', authMode: 'ticket' }
      } else {
        oauthProvider = choice.provider
        // Reuse a still-live session (e.g. a restored cookie jar, R2b) rather than
        // forcing an interactive sign-in; only open the webview when signed out.
        const live = await oauthStatus(base).catch(() => ({ signedIn: false }))

        if (!live.signedIn) {
          // On Android this navigates the app away and never returns here — the reload
          // resumes via the pending marker (see beginOAuthLogin / autoRestoreConnection).
          await beginOAuthLogin(base, oauthProvider, input.username)
        }

        conn = { baseUrl: base, mode: 'remote', authMode: 'oauth' }
      }
    } else if (input.token && input.token.trim()) {
      conn = { baseUrl: base, mode: 'remote', authMode: 'token', token: input.token.trim() }
    } else {
      conn = { baseUrl: base, mode: 'remote', authMode: 'none' }
    }

    $connection.set(conn)
    $connectionPhase.set('connecting')

    try {
      await connectGateway(conn)
    } catch (err) {
      // An OAuth session that expired between the status check and the ws-ticket
      // mint surfaces as GatewayReauthRequiredError — re-run sign-in once.
      if (conn.authMode === 'oauth' && isGatewayReauthRequired(err)) {
        await beginOAuthLogin(base, oauthProvider, input.username)
        await connectGateway(conn)
      } else {
        throw err
      }
    }

    $connectionPhase.set('ready')
    // Non-secret prefill in localStorage; secrets in the keyring (best-effort —
    // if the keyring is unavailable, secrets simply aren't persisted).
    saveString(URL_KEY, input.url.trim())
    saveString(USER_KEY, input.username ?? '')
    await saveSecrets({ token: input.token?.trim() || undefined, password: input.password || undefined })
    // Persist the session cookie jar (R2b) so a cookie-backed login (ticket now,
    // oauth/cloud once D6/E land) survives an app restart. No-op in token/none mode.
    await persistSessionCookies()
    // Remember this target so the next launch auto-reconnects (D8).
    saveGatewayTarget({ mode: 'remote', url: input.url.trim(), username: input.username || undefined })
  } catch (err) {
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

/**
 * Local mode (E3.b, desktop-only): spawn a bundled backend and connect to it in
 * token mode. The Rust command resolves only once the backend is HTTP-ready.
 */
export async function connectLocal(profile?: null | string): Promise<void> {
  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('connecting')

  try {
    const backend = await spawnLocalBackend(profile)

    const conn: Connection = {
      baseUrl: backend.baseUrl,
      mode: 'local',
      authMode: 'token',
      token: backend.token,
      profile: profile ?? null
    }

    $connection.set(conn)
    await connectGateway(conn)
    $connectionPhase.set('ready')
    // Remember this target so the next launch auto-reconnects (D8).
    saveGatewayTarget({ mode: 'local', profile: profile ?? null })
  } catch (err) {
    // Tear the child down so a failed connect doesn't leave an orphan process.
    void stopLocalBackend().catch(() => {})
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

/** The non-secret half of an SSH target, as the settings form collects it. */
export type SshTarget = Omit<
  SshConnectConfig,
  'privateKeyPem' | 'passphrase' | 'password' | 'installationId' | 'reuseToken' | 'interactive'
>

/**
 * SSH mode (MJX-55): reach a backend on a remote host through an SSH tunnel.
 *
 * Rust does the whole lifecycle and hands back a token-authed backend on
 * loopback, so from here this looks much more like `connectLocal` than like
 * `connect` — there is no /api/status probe and no auth negotiation, because the
 * tunnel already terminates at a backend we started ourselves.
 *
 * `onProgress` matters more than it looks: a cold connect spawns a process on
 * the remote and waits for it to bind, which can take 45–90s. Without it the UI
 * shows a motionless spinner for long enough to read as a hang.
 */
export async function connectSsh(
  target: SshTarget,
  options: { interactive?: boolean; attemptId?: string } = {}
): Promise<void> {
  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('connecting')

  const attemptId = options.attemptId ?? newAttemptId()
  const profile = target.profile ?? null

  try {
    // Secrets come from the keyring, never from the saved target.
    const [installationId, sshSecrets, saved] = await Promise.all([
      getInstallationId(),
      loadSshSecrets(),
      loadSavedLogin().catch(() => null)
    ])

    const backend = await connectSshBackend(attemptId, {
      ...target,
      profile,
      installationId,
      privateKeyPem: sshSecrets.privateKeyPem,
      passphrase: sshSecrets.passphrase,
      password: sshSecrets.password,
      // The previous session token is what lets Rust REATTACH to a backend that
      // is already running remotely instead of spawning a second one.
      reuseToken: saved?.token || undefined,
      interactive: options.interactive ?? false
    })

    const conn: Connection = {
      baseUrl: backend.baseUrl,
      mode: 'ssh',
      authMode: 'token',
      token: backend.token,
      profile,
      remoteHost: backend.hostLabel,
      // Stable across re-tunnels, unlike baseUrl — see connectionCacheKey.
      remoteIdentity: backend.ownershipId
    }

    $connection.set(conn)
    await connectGateway(conn)
    $connectionPhase.set('ready')

    // Persist the token so the NEXT launch can reattach rather than respawn.
    await saveSecrets({ token: backend.token })
    saveGatewayTarget({ mode: 'ssh', profile, ssh: target })
  } catch (err) {
    // Drop the tunnel so a failed connect does not leave one open. The remote
    // backend is deliberately left alone — Rust already reaped it if the failure
    // was its own.
    void disconnectSsh(profile).catch(() => {})
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

/**
 * Cloud mode (E5): connect to a portal-discovered agent's gateway. The agent
 * session cookie is already in the shared jar (portal_agent_sign_in ran first),
 * so this is an OAuth-style connect — the WS mints a ticket from that cookie.
 */
export async function connectCloud(baseUrl: string, profile?: null | string): Promise<void> {
  armReconnect()
  $connectionError.set(null)
  $connectionPhase.set('connecting')

  try {
    const conn: Connection = {
      baseUrl: normalizeBaseUrl(baseUrl),
      mode: 'cloud',
      authMode: 'oauth',
      profile: profile ?? null
    }

    $connection.set(conn)

    try {
      await connectGateway(conn)
    } catch (err) {
      // An already-expired agent session surfaces as GatewayReauthRequiredError —
      // re-run the silent SSO once, mirroring connect()'s oauth retry.
      if (isGatewayReauthRequired(err)) {
        await portalAgentSignIn(conn.baseUrl)
        await connectGateway(conn)
      } else {
        throw err
      }
    }

    $connectionPhase.set('ready')
    await persistSessionCookies()
    // Remember this target so the next launch auto-reconnects (D8). connectCloudAgent
    // enriches it with the agent id/name afterwards (for the restore label).
    saveGatewayTarget({ mode: 'cloud', cloudBaseUrl: conn.baseUrl, profile: profile ?? null })
  } catch (err) {
    $connectionError.set(err instanceof Error ? err.message : String(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  }
}

export function disconnect(): void {
  // Mark this as a deliberate close so the reconnect supervisor stands down.
  intentionalClose = true
  // A deliberate disconnect ends the session: the root gate falls back to the
  // connect picker (not the reconnecting screen) next.
  $hasConnected.set(false)

  const conn = $connection.get()

  // If we were on a local-spawned backend, stop the child too.
  if (conn?.mode === 'local') {
    void stopLocalBackend().catch(() => {})
  }

  // For SSH this drops the TUNNEL only. The remote backend stays up on purpose
  // (it is detached) so the next connect reattaches instead of paying a full
  // spawn — matching desktop.
  if (conn?.mode === 'ssh') {
    void disconnectSsh(conn.profile ?? null).catch(() => {})
  }

  closeGateway()
  $connection.set(null)
  $connectionPhase.set('idle')
  $connectionError.set(null)
}

/**
 * Sign out: unlike disconnect() (which only drops the socket), this invalidates
 * the session — revokes the gateway OAuth cookie, clears the portal (Privy)
 * session for cloud, forgets stored secrets (incl. the persisted cookie jar),
 * then disconnects.
 */
export async function signOut(): Promise<void> {
  const conn = $connection.get()

  if (conn?.authMode === 'oauth') {
    await oauthLogout(conn.baseUrl).catch(() => {})
  }

  if (conn?.mode === 'cloud') {
    await portalLogout().catch(() => {})
  }

  await forgetSavedLogin().catch(() => {})
  disconnect()
}

// --------------------------------------------------------------------------
// Auto-reconnect supervisor (D7)
// --------------------------------------------------------------------------
// The vendored client has no reconnect logic, so a dropped socket (sleep/wake,
// network blip, expired session) leaves the app 'closed'. This watches
// $gatewayState and, on an UNEXPECTED close, re-dials with capped backoff:
// connectGateway re-mints a FRESH ws-ticket each attempt, and on an expired OAuth
// session it re-drives sign-in first. Guards against re-dialling a user-initiated
// disconnect and against re-entrant loops (the close a reconnect itself triggers).
//
// FIXME(D7): reconnect re-opens the socket; it does not respawn a local backend
// whose process actually died, nor replay an interrupted streaming turn.

let intentionalClose = false
let reconnecting = false

/** Allow auto-reconnect after a fresh (re)connect attempt. */
function armReconnect(): void {
  intentionalClose = false
}

const reconnectDelay = (attempt: number): number => Math.min(30_000, 2 ** attempt * 1000)
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Unreachable for `ssh`: that mode is always authMode 'token', and the loop only
// calls this on a GatewayReauthRequiredError, which the ticket/oauth paths raise.
// A dropped SSH TUNNEL is a different failure and is not handled here — see the
// FIXME above.
async function reauthForReconnect(conn: Connection): Promise<void> {
  if (conn.mode === 'cloud') {
    await portalAgentSignIn(conn.baseUrl)
  } else {
    // Android: navigates the app away and reloads; the pending marker resumes the dial.
    await beginOAuthLogin(conn.baseUrl)
  }
}

async function runReconnectLoop(): Promise<void> {
  reconnecting = true
  let attempt = 0

  while (!intentionalClose) {
    const conn = $connection.get()

    if (!conn) {
      break
    }

    await wait(reconnectDelay(attempt))

    if (intentionalClose || !$connection.get()) {
      break
    }

    $connectionPhase.set('connecting')

    try {
      await connectGateway(conn)

      if (intentionalClose || !$connection.get()) {
        closeGateway()

        break
      }

      $connectionPhase.set('ready')

      break
    } catch (err) {
      if (conn.authMode === 'oauth' && isGatewayReauthRequired(err)) {
        try {
          await reauthForReconnect(conn)
          await connectGateway(conn)
          $connectionPhase.set('ready')

          break
        } catch {
          // fall through to backoff
        }
      }

      attempt++
    }
  }

  reconnecting = false
}

$gatewayState.subscribe(state => {
  if (state === 'closed' && !intentionalClose && !reconnecting && $connection.get()) {
    void runReconnectLoop()
  }
})

// Latch "has connected this session" on every ready transition (initial connect,
// local/cloud connect, and each successful auto-reconnect). One place covers them
// all; `disconnect()` clears it.
$connectionPhase.subscribe(phase => {
  if (phase === 'ready') {
    $hasConnected.set(true)
  }
})
