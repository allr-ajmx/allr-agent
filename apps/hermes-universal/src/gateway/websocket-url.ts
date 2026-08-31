export type GatewayAuthMode = 'oauth' | 'token' | (string & {})

export interface GatewayWsConnection {
  authMode?: GatewayAuthMode | null
  profile?: null | string
  wsUrl: string
}

export interface ResolveGatewayWsUrlDeps {
  /**
   * Returns a fresh WebSocket URL for the selected backend/profile.
   * OAuth-gated gateways use single-use tickets, so callers should mint
   * immediately before opening the socket.
   */
  getGatewayWsUrl?: (profile?: null | string) => Promise<string>
}

export class GatewayReauthRequiredError extends Error {
  readonly needsOauthLogin = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GatewayReauthRequiredError'
  }
}

export function isGatewayReauthRequired(error: unknown): error is GatewayReauthRequiredError {
  return (
    error instanceof GatewayReauthRequiredError ||
    (typeof error === 'object' && error !== null && (error as { needsOauthLogin?: unknown }).needsOauthLogin === true)
  )
}

/**
 * This gateway needs an interactive sign-in, and nobody asked for one.
 *
 * Deliberately NOT a `GatewayReauthRequiredError`, and deliberately carrying a
 * different marker, because the two demand opposite responses. Reauth-required
 * means "you had a session, go silently get another" — something the app may do
 * on its own. This means "there is no session and the only way to get one is to
 * hand the user to a login page", which the app may never do by itself: on mobile
 * that navigates the only webview away with no user intent, and on desktop it
 * throws up a window nobody opened.
 *
 * A caller that sees this stops and surfaces a Sign in button. It does not retry,
 * because retrying cannot help — the credential is not coming back on its own.
 */
export class GatewaySignInRequiredError extends Error {
  readonly needsInteractiveSignIn = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GatewaySignInRequiredError'
  }
}

/**
 * A sign-in was needed, and one is already running — started by someone else.
 *
 * Nothing has gone wrong: the user is, right now, looking at the login page that
 * the winning flow opened. The only correct response is to stop quietly. Retrying
 * would be refused again, and surfacing an error would put a failure message
 * under a sign-in that is about to succeed.
 */
export class GatewaySignInBusyError extends Error {
  readonly signInAlreadyRunning = true

  constructor(message: string) {
    super(message)
    this.name = 'GatewaySignInBusyError'
  }
}

export function isGatewaySignInBusy(error: unknown): error is GatewaySignInBusyError {
  return (
    error instanceof GatewaySignInBusyError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { signInAlreadyRunning?: unknown }).signInAlreadyRunning === true)
  )
}

export function isGatewaySignInRequired(error: unknown): error is GatewaySignInRequiredError {
  return (
    error instanceof GatewaySignInRequiredError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { needsInteractiveSignIn?: unknown }).needsInteractiveSignIn === true)
  )
}

export async function resolveGatewayWsUrl(deps: ResolveGatewayWsUrlDeps, conn: GatewayWsConnection): Promise<string> {
  const mint = deps.getGatewayWsUrl
  const profile = conn.profile ?? null

  if (conn.authMode === 'oauth') {
    if (!mint) {
      throw new GatewayReauthRequiredError(
        'Your remote gateway session needs to be refreshed. Open Settings -> Gateway and click "Sign in" again.'
      )
    }

    try {
      return await mint(profile)
    } catch (error) {
      // Only a REFUSAL means the session expired, and `mintWsTicket` already
      // raises the typed error for that (an HTTP 401 from the ws-ticket mint).
      // Everything else reaching here — DNS, connection refused, TLS, a timeout —
      // is a network fault, and relabelling it "your session has expired" was the
      // mirror image of the bug on the other side: it spent the supervisor's
      // 3-attempt AUTH budget on a blip that the unbounded network ladder would
      // have ridden out, and told the user to sign in again when nothing was
      // wrong with their credential.
      if (isGatewayReauthRequired(error)) {
        throw error
      }

      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  if (mint) {
    const fresh = await mint(profile).catch(() => null)

    if (fresh) {
      return fresh
    }
  }

  return conn.wsUrl
}

export type WebSocketAuthParam = readonly [name: string, value: string]

export interface HermesWebSocketUrlOptions {
  /** Dashboard or gateway-relative endpoint path, e.g. "/api/ws". */
  path: string
  /** Optional URL prefix when the backend is reverse-proxied below a subpath. */
  basePath?: string
  /** Query auth pair, usually ["token", value] or ["ticket", value]. */
  authParam?: WebSocketAuthParam
  /** Extra query params merged before auth. */
  params?: Record<string, string>
  /** Browser protocol string such as "https:"; defaults to window.location.protocol. */
  protocol?: string
  /** Host with optional port; defaults to window.location.host. */
  host?: string
}

function readWindowLocation(): { host: string; protocol: string } {
  if (typeof window === 'undefined') {
    return { host: '', protocol: 'http:' }
  }

  return { host: window.location.host, protocol: window.location.protocol }
}

function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath) {
    return ''
  }

  const withLead = basePath.startsWith('/') ? basePath : `/${basePath}`

  return withLead.replace(/\/+$/, '')
}

function normalizeEndpointPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

export function buildHermesWebSocketUrl(options: HermesWebSocketUrlOptions): string {
  const loc = readWindowLocation()
  const protocol = options.protocol ?? loc.protocol
  const host = options.host ?? loc.host
  const wsScheme = protocol === 'https:' || protocol === 'wss:' ? 'wss:' : 'ws:'
  const qs = new URLSearchParams(options.params ?? {})

  if (options.authParam) {
    const [name, value] = options.authParam
    qs.set(name, value)
  }

  const query = qs.toString()
  const suffix = query ? `?${query}` : ''

  return `${wsScheme}//${host}${normalizeBasePath(options.basePath)}${normalizeEndpointPath(options.path)}${suffix}`
}
