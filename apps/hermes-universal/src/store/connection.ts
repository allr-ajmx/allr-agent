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
import { errorText } from '@/lib/error-text'
import { loadString, saveString } from '@/lib/persist'
import { IS_NATIVE_MOBILE } from '@/lib/platform'
import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'
import { clearSecrets, loadSecrets, loadSshSecrets, saveSecrets, type Secrets } from '@/lib/secure-store'
import { persistSessionCookies } from '@/lib/session-persist'
import { onBackground, onForeground } from '@/store/app-lifecycle'
import { atom } from '@/store/atom'
import { $gatewayState, closeGateway, connectGateway } from '@/store/gateway'
import { chooseGatedAuth, type Connection } from '@/store/gateway-config'
import {
  loadGatewayTarget,
  saveGatewayTarget,
  savePendingOAuth,
  takePendingOAuth
} from '@/store/gateway-restore'
import { getInstallationId } from '@/store/installation-id'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import {
  $sshStep,
  cancelSsh,
  connectSshBackend,
  disconnectSsh,
  newAttemptId,
  onSshDisconnected,
  onSshProgress,
  type SshConnectConfig
} from '@/store/ssh-backend'
import { httpRequest } from '@/transport/http'

// AuthMode / Connection are now defined in store/gateway-config (the reconciled
// model incl. 'oauth' + gateway mode). Re-exported here so existing importers of
// '@/store/connection' keep working.
export type { AuthMode, Connection } from '@/store/gateway-config'

// The RemoteProvider: resolve a LAN/remote Allr backend URL + auth, then hold
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
  /** Which sign-in flows this gateway can run — `"cookie"` always when gated,
   *  `"native_pkce"` only when a provider can broker an RFC 8252 native login
   *  (`hermes_cli/web_server.py`). Absent on gateways older than those routes,
   *  which is the compatibility mechanism: see `lib/native-auth-decisions.ts`.
   *  Rust re-probes this itself before choosing a flow (`oauth.rs`); the field is
   *  declared here so surfaces can say WHICH way the user is signed in. */
  auth_flows?: string[]
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

/** Forget the saved secrets (e.g. a "sign out everywhere" affordance).
 *
 *  Resolves false when the wipe did not land — the keystore was unreachable, or
 *  it refused. Callers that tell the user they are signed out everywhere should
 *  check: a failed wipe used to be indistinguishable from a clean one. */
export function forgetSavedLogin(): Promise<boolean> {
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
 * On desktop this opens a dedicated sign-in window and the promise resolves when the
 * session lands. On ANDROID AND iOS the Rust command navigates the CALLING webview to the
 * login and back (neither phone can host a dismissable second window — see
 * src-tauri/src/oauth.rs); that navigation destroys this JS context, so `oauthLogin` never
 * resolves here. We persist a one-shot resume marker FIRST so the post-reload boot
 * (`autoRestoreConnection`) finishes the connect. Callers must treat this as "may never
 * return" on mobile.
 *
 * Both mobile flows navigate away — the RFC 8252 one to `/auth/native/authorize`, the
 * cookie cascade to `/auth/login` — so the marker is right for either.
 */
async function beginOAuthLogin(base: string, provider?: string, username?: string): Promise<void> {
  if (!IS_NATIVE_MOBILE) {
    await oauthLogin(base, provider)

    return
  }

  savePendingOAuth({ base, provider, username })

  try {
    await oauthLogin(base, provider)
  } catch (err) {
    // A REJECTION on mobile means we never navigated (Rust failed to bind the loopback
    // listener, or the webview refused the load) — this JS context is still alive and
    // the caller is about to surface the error. The marker we parked is now garbage
    // that would otherwise sit in localStorage and fire on some unrelated later launch,
    // seeding `$restoring` and sending the boot down the resume branch for a sign-in
    // that never happened.
    takePendingOAuth()

    throw err
  }
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
          // On mobile this navigates the app away and never returns here — the reload
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
    $connectionError.set(errorText(err))
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
    $connectionError.set(errorText(err))
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
  // Tracked so `disconnect()` can abort a dial that is still running. A cold SSH
  // connect can take 90s, and without this the "Use a different gateway" escape
  // hatch only *looks* like it worked: the UI moves on while Rust keeps
  // spawning a backend on the remote.
  activeSshAttempt = attemptId

  // Publish progress for surfaces that never see the attempt id — the connecting
  // screen during a boot restore, and the tunnel re-bootstrap. Subscribed before
  // the invoke so no step is missed.
  const unlistenProgress = await onSshProgress(attemptId, progress => $sshStep.set(progress.step)).catch(() => null)

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
    await watchSshTunnel(profile)
  } catch (err) {
    // Drop the tunnel so a failed connect does not leave one open. The remote
    // backend is deliberately left alone — Rust already reaped it if the failure
    // was its own.
    void disconnectSsh(profile).catch(() => {})
    $connectionError.set(errorText(err))
    $connectionPhase.set('error')
    $connection.set(null)
    throw err
  } finally {
    unlistenProgress?.()
    $sshStep.set(null)

    if (activeSshAttempt === attemptId) {
      activeSshAttempt = null
    }
  }
}

/** The in-flight SSH dial, if any, so a deliberate disconnect can abort it. */
let activeSshAttempt: null | string = null

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
    $connectionError.set(errorText(err))
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
    stopWatchingSshTunnel()
    void disconnectSsh(conn.profile ?? null).catch(() => {})
  }

  // Abort a dial that has not produced a connection yet — at this point there is
  // no `conn` to branch on, so this sits outside the check above.
  if (activeSshAttempt) {
    void cancelSsh(activeSshAttempt).catch(() => {})
    activeSshAttempt = null
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
// SSH tunnel watchdog
// --------------------------------------------------------------------------
// The reconnect supervisor below re-opens the WEBSOCKET. That is enough for a
// dropped socket, but not for a dropped SSH SESSION: the baseUrl points at a
// local ephemeral port that only exists while the tunnel does, so once the
// session dies the supervisor re-dials a port nothing is listening on, backs off
// to 30s, and spins forever.
//
// Rust tells us when that happens. The fix is a full re-bootstrap rather than a
// re-dial — and because the remote backend was left running deliberately, that
// bootstrap hits the REUSE path (lockfile + /api/ssh/ownership proof) and
// reattaches in about two seconds instead of respawning.

let sshWatcher: null | (() => void) = null

async function watchSshTunnel(profile: null | string): Promise<void> {
  sshWatcher?.()
  sshWatcher = null

  const unlisten = await onSshDisconnected(profile, () => {
    // A deliberate disconnect does not emit this, but the user may have torn the
    // connection down between the event firing and it arriving.
    if (intentionalClose || $connection.get()?.mode !== 'ssh') {
      return
    }

    void rebootstrapSsh(profile)
  }).catch(() => null)

  if (unlisten) {
    sshWatcher = unlisten
  }
}

/** Stop watching (a deliberate disconnect, or a switch to another mode). */
function stopWatchingSshTunnel(): void {
  sshWatcher?.()
  sshWatcher = null
}

let rebootstrapping = false

async function rebootstrapSsh(profile: null | string): Promise<void> {
  if (rebootstrapping) {
    return
  }

  rebootstrapping = true

  try {
    const target = loadGatewayTarget()

    if (!target?.ssh?.host) {
      return
    }

    // Non-interactive: this fires on its own schedule, with no user waiting on a
    // dialog. Keyring-held credentials are all it gets.
    await connectSsh({ ...target.ssh, profile }, { interactive: false })
  } catch {
    // connectSsh already set $connectionError + phase; the connecting screen
    // surfaces it and the ordinary supervisor keeps retrying the socket.
  } finally {
    rebootstrapping = false
  }
}

// --------------------------------------------------------------------------
// Auto-reconnect supervisor (D7)
// --------------------------------------------------------------------------
// The vendored client has no reconnect logic, so a dropped socket (sleep/wake,
// network blip, expired session) leaves the app 'closed'. This watches
// $gatewayState and, on an UNEXPECTED close, re-dials with FULL-JITTER capped
// backoff (lib/reconnect-backoff): connectGateway re-mints a FRESH ws-ticket
// each attempt, and on an expired OAuth session it re-drives sign-in first.
// Guards against re-dialling a user-initiated disconnect and against re-entrant
// loops (the close a reconnect itself triggers).
//
// Jitter matters because a gateway restart drops every app pointed at it in the
// same instant; a deterministic ladder then has them all redial in the same
// instant too, which can exhaust the gateway's descriptors while it is still
// coming back up.
//
// FIXME(D7): reconnect re-opens the socket; it does not respawn a local backend
// whose process actually died, nor replay an interrupted streaming turn.

let intentionalClose = false
let reconnecting = false
let switching = false

/** Allow auto-reconnect after a fresh (re)connect attempt. */
function armReconnect(): void {
  intentionalClose = false
}

/**
 * A soft gateway switch is starting (store/gateway-switch.ts): stand the reconnect
 * supervisor down so it doesn't race the deliberate re-dial. Lives here rather than
 * reading `$gatewaySwitching` because connection.ts must not import gateway-switch.ts
 * (that store already imports this one — the seam keeps the store graph acyclic).
 *
 * Two flags are needed: `intentionalClose` covers the teardown, but every connect*()
 * calls armReconnect() at the top of the dial, so only `switching` keeps the ladder
 * down through the NEW gateway's handshake.
 */
export function beginGatewaySwitch(): void {
  switching = true
  intentionalClose = true
}

/** The switch finished (or failed): re-arm the supervisor against the new connection. */
export function endGatewaySwitch(): void {
  switching = false
}

/**
 * Once the loop has been failing continuously for this long, publish the last
 * failure on `$connectionError`. That is what reveals the embedded gateway
 * configurator on the connecting screen (see gateway-connecting-screen.tsx), so
 * a gateway that never comes back stops being a spinner with no way out.
 *
 * Time-based rather than attempt-count-based, because full jitter makes attempt
 * counts a meaningless clock: six jittered attempts can elapse in ~9s, while
 * the old deterministic 1→30s ladder took ~45s to reach six failures. 45s keeps
 * that original calibration (matching desktop's RECONNECT_ESCALATE_AFTER_MS).
 */
const RECONNECT_ESCALATE_AFTER_MS = 45_000

/**
 * How many AUTH failures the supervisor will absorb before standing down.
 *
 * Auth and network failures get different policies on purpose, and collapsing
 * them would be a regression in one direction or the other. A revoked credential
 * does not become valid by being asked again, so an uncapped ladder on 401s is a
 * spinner the user can never escape. A network failure is the opposite: refused,
 * timed out, DNS, a gateway mid-restart — those genuinely do resolve on their
 * own, and capping them would make a phone that spent 60s in a lift give up
 * permanently. So only this counter is bounded; network failures keep the
 * uncapped ladder and rely on RECONNECT_ESCALATE_AFTER_MS for their way out.
 *
 * Three rather than one because a rotation genuinely can race a dial — the
 * bearer refreshed out from under an in-flight mint — and that deserves more
 * than a single retry before the session is declared dead.
 *
 * Not a dead end: `wakeReconnect()` resets this, so returning to the app always
 * buys a fresh budget (store/app-lifecycle.ts).
 */
const MAX_AUTH_ATTEMPTS = 3

const reconnectDelay = (attempt: number): number => reconnectBackoffDelayMs(attempt)
// Cancels the backoff currently being slept off, if any. Set for the duration of
// each sleep so a foreground wake can cut it short — the ladder's cap is 15s, and a
// user who just reopened the app should not have to sit out the remainder of one.
let cancelBackoffSleep: null | (() => void) = null

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cancelBackoffSleep = null
      resolve()
    }, ms)

    cancelBackoffSleep = () => {
      clearTimeout(timer)
      cancelBackoffSleep = null
      resolve()
    }
  })
}

// DESKTOP ONLY — see the reauth branch in the loop for why mobile must never reach here.
//
// Unreachable for `ssh`: that mode is always authMode 'token', and the loop only
// calls this on a GatewayReauthRequiredError, which the ticket/oauth paths raise.
// A dropped SSH TUNNEL is a different failure and is not handled here — see the
// FIXME above.
async function reauthForReconnect(conn: Connection): Promise<void> {
  if (conn.mode === 'cloud') {
    await portalAgentSignIn(conn.baseUrl)
  } else {
    // Opens a dedicated sign-in window beside the app and resolves when the session
    // lands, so the dial below can simply continue.
    await beginOAuthLogin(conn.baseUrl)
  }
}

// Set by `wakeReconnect`, consumed at the top of each loop iteration: it skips the
// pending backoff and refunds the auth budget for the coming attempt. Only
// `wakeReconnect` sets it and only the loop clears it, so a wake that arrives while
// no loop is running is still honoured by the loop it starts.
let wakeRequested = false

/**
 * Wake a backed-off reconnect loop and give it a fresh budget.
 *
 * Called when the user brings the app back to the front (store/app-lifecycle.ts).
 * Two jobs, and both matter on a phone:
 *
 *  • The ladder's next attempt can be up to 15s away, and a user staring at a
 *    spinner they just returned to should not wait it out.
 *  • The auth budget is reset, so a session that stood down as expired gets one
 *    clean round of attempts every time the user actually comes back rather than
 *    staying dead until the app is relaunched. This is what keeps
 *    MAX_AUTH_ATTEMPTS from being a trap: the cap ends a spinner, it does not end
 *    the session permanently.
 *
 * Re-arming a loop that already stood down is safe — it re-enters through the
 * same `$gatewayState` path any other drop takes.
 */
export function wakeReconnect(): void {
  if (intentionalClose || switching || !$connection.get()) {
    return
  }

  wakeRequested = true

  // A loop already running is asleep on its backoff; cut that short so the flag is
  // acted on now rather than up to 15s from now.
  cancelBackoffSleep?.()

  // A loop that already stood down (the auth budget, or a socket that closed while
  // nothing was watching) has to be re-entered. It re-arms through the same path any
  // other drop takes.
  if (!reconnecting && $gatewayState.get() === 'closed') {
    void runReconnectLoop()
  }
}

async function runReconnectLoop(): Promise<void> {
  reconnecting = true
  let attempt = 0
  // Consecutive AUTH failures this episode (401 / reauth-required), tracked apart
  // from `attempt` because the two get different budgets — see MAX_AUTH_ATTEMPTS.
  // Episode-scoped like `failingSince`: every success leaves the loop, so a later
  // drop starts a fresh count. A foreground wake refunds it mid-episode.
  let authAttempts = 0
  // Wall-clock start of this disconnect episode (the first FAILED reconnect),
  // null while we have not failed yet. Drives the escalation below. Episode-
  // scoped by construction: the loop is re-entered fresh per episode.
  let failingSince: null | number = null

  while (!intentionalClose && !switching) {
    const conn = $connection.get()

    if (!conn) {
      break
    }

    // A foreground wake skips the pending backoff and refunds the auth budget:
    // the user is back and looking at this, so make the attempt now and give a
    // stood-down session a genuine second chance.
    if (wakeRequested) {
      wakeRequested = false
      attempt = 0
      authAttempts = 0
      failingSince = null
    } else {
      await sleep(reconnectDelay(attempt))
    }

    if (intentionalClose || switching || !$connection.get()) {
      break
    }

    $connectionPhase.set('connecting')

    try {
      // For ssh, re-dialling the socket is pointless if the tunnel is what died —
      // the port is gone with it. Re-bootstrap instead; it reattaches to the
      // still-running remote backend through the reuse path.
      if (conn.mode === 'ssh') {
        await rebootstrapSsh(conn.profile ?? null)

        if ($connectionPhase.get() === 'ready') {
          break
        }

        throw new Error('SSH re-bootstrap did not reach a live connection')
      }

      await connectGateway(conn)

      if (intentionalClose || switching || !$connection.get()) {
        closeGateway()

        break
      }

      $connectionError.set(null)
      $connectionPhase.set('ready')

      break
    } catch (err) {
      // Auth failures spend their own budget. A credential the gateway refuses does
      // not become valid by being asked again, so this is the counter that has to
      // terminate — otherwise a genuinely expired session is an endless spinner. It
      // is checked BEFORE the mode-specific handling below so every auth path
      // (ticket, oauth, cloud, desktop re-auth) shares one stopping rule.
      if (isGatewayReauthRequired(err)) {
        authAttempts++

        if (authAttempts >= MAX_AUTH_ATTEMPTS) {
          // Stand down onto a screen with a working Sign in button — the correct
          // terminal state for a session that really is dead. `$connectionError` is
          // what reveals the embedded configurator on the connecting screen
          // (gateway-connecting-screen.tsx). A later `wakeReconnect()` refunds the
          // budget, so this ends the spinner without ending the session forever.
          $connectionError.set(errorText(err))

          break
        }
      }

      if (conn.authMode === 'oauth' && isGatewayReauthRequired(err)) {
        // On mobile an interactive sign-in is a ONE-WAY DOOR: it navigates the app's only
        // webview to the login page and never returns (see `beginOAuthLogin`). This loop
        // is a BACKGROUND actor — it wakes on any dropped socket, with no user intent — so
        // walking through that door hijacks the whole app at an arbitrary moment, most
        // cruelly right as the user brings it back from the background.
        //
        // Worse, it does not hold the webview against anyone else. A user tapping Sign in
        // on the connect screen starts a second flow, which reads `webview.url()` AFTER
        // this one has already navigated and so captures the LOGIN PAGE as its "return
        // here afterwards" target. Whichever finishes last then restores the app to the
        // login page, and there is no way home. That is a real crash-and-strand seen on
        // device, not a theoretical race.
        //
        // So: report it and stand down. The user gets one deliberate, foreground sign-in.
        // `$connectionError` is what reveals the embedded configurator on the connecting
        // screen (gateway-connecting-screen.tsx), and `mintWsTicket` has already phrased
        // this for a human — "Session expired — sign in again".
        //
        // Published immediately rather than after RECONNECT_ESCALATE_AFTER_MS: that window
        // exists to let a transient failure resolve itself, and a refused credential is not
        // transient. Nothing is gained by making the user watch a spinner for 45s first.
        //
        // Two carve-outs, both because the door is not one-way for them:
        //   * DESKTOP opens a dedicated sign-in window beside the app and resolves, so the
        //     supervisor can re-auth without the user ever knowing.
        //   * CLOUD re-auths through `portalAgentSignIn`, which on mobile is the silent
        //     reqwest cascade (`cloud.rs::agent_sso`) — nothing navigates, so it is safe to
        //     drive from the background and blocking it would be a pointless regression.
        if (IS_NATIVE_MOBILE && conn.mode !== 'cloud') {
          $connectionError.set(errorText(err))

          break
        }

        try {
          await reauthForReconnect(conn)
          await connectGateway(conn)
          $connectionError.set(null)
          $connectionPhase.set('ready')

          break
        } catch {
          // fall through to backoff
        }
      }

      if (failingSince === null) {
        failingSince = Date.now()
      }

      // Past the escalation window, stop swallowing the failure: publishing it
      // reveals the configurator on the connecting screen, so a gateway that is
      // never coming back has a way out instead of an endless spinner. The last
      // error is used verbatim — it says WHY, which a generic string cannot.
      if (Date.now() - failingSince >= RECONNECT_ESCALATE_AFTER_MS) {
        $connectionError.set(errorText(err))
      }

      attempt++
    }
  }

  reconnecting = false
}

$gatewayState.subscribe(state => {
  if (state === 'closed' && !intentionalClose && !switching && !reconnecting && $connection.get()) {
    void runReconnectLoop()
  }
})

// Latch "has connected this session" on every ready transition (initial connect,
// local/cloud connect, and each successful auto-reconnect). One place covers them
// all; `disconnect()` clears it.
//
// The same hook re-snapshots the cookie jar, because the persisted copy goes stale
// the moment the gateway rotates anything. `persistSessionCookies` used to run only
// at the end of connect()/connectCloud(), so the keyring kept whatever pair the
// FIRST dial saw while the live Rust jar took every rotated `allr_session_at`/`_rt`
// the server sent afterwards. A cold boot then imported credentials that had been
// rotated away hours earlier — and against a provider with reuse detection (the
// portal rotates its refresh token on every use) that is an actively revoked
// session, not merely a stale one. Every transition to `ready` is the right trigger:
// it covers the initial dial, each auto-reconnect, and each soft gateway switch.
$connectionPhase.subscribe(phase => {
  if (phase === 'ready') {
    $hasConnected.set(true)
    schedulePersistSessionCookies()
  }
})

// Debounced so a burst of ready transitions (a soft switch re-dialling, a flapping
// socket) costs one keyring write rather than one per transition — the export walks
// the jar and the write can go over IPC to another process on desktop.
let persistCookiesTimer: null | ReturnType<typeof setTimeout> = null

function schedulePersistSessionCookies(): void {
  if (persistCookiesTimer !== null) {
    clearTimeout(persistCookiesTimer)
  }

  persistCookiesTimer = setTimeout(() => {
    persistCookiesTimer = null
    void persistSessionCookies()
  }, 1_000)
}

/** Snapshot the jar now, skipping the debounce. Called when the app is about to be
 *  backgrounded (store/app-lifecycle.ts): the process may not survive to run a
 *  pending timer, and the rotation it is holding is the one the next launch needs. */
export function flushSessionCookies(): void {
  if (persistCookiesTimer !== null) {
    clearTimeout(persistCookiesTimer)
    persistCookiesTimer = null
  }

  void persistSessionCookies()
}

// Wire the connection half of the app lifecycle. Called once from main.tsx, after
// `initAppLifecycle()`.
//
//  • foreground — wake a backed-off reconnect and refund the auth budget, so a
//    user who just came back is not watching out a 15s jittered sleep and a
//    session that stood down as expired gets one clean re-try.
//  • background — snapshot the cookie jar NOW rather than on the debounce, because
//    the process may not live long enough to run a pending timer and the rotation
//    it holds is exactly what the next cold launch needs.
export function initConnectionLifecycle(): void {
  onForeground(wakeReconnect)
  onBackground(flushSessionCookies)
}
