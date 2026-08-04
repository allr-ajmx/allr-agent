import { buildHermesWebSocketUrl, type GatewayWsConnection, resolveGatewayWsUrl } from '@/gateway'
import { type AuthProvider, mintWsTicket } from '@/lib/auth'

// Reconciled gateway model (D5.a) — the single source of truth for how the app
// reaches a Hermes backend. It unifies two enums that had drifted: this app's
// original `none|token|ticket` (store/connection.ts) and the vendored gateway's
// `oauth|token` (gateway/websocket-url.ts), and adds the desktop-style gateway
// `mode` (local/remote/cloud) that Track E switches between.
//
// Pure + I/O-free except `resolveWsUrl`, whose only effect is the injected
// ws-ticket mint. Everything here is unit-testable against a mocked mint.

/** How the backend is reached.
 *  - `cloud` is a `remote`-shaped OAuth connection whose baseUrl was discovered
 *    via the portal (see modeIsRemoteLike).
 *  - `ssh` is a token-authed backend on 127.0.0.1 reached through an SSH tunnel.
 *    Rust spawns (or reattaches to) `hermes serve` on the remote host and
 *    forwards a loopback port to it, so from here it behaves like `local`, not
 *    like `remote`. */
export type GatewayMode = 'local' | 'remote' | 'cloud' | 'ssh'

/** How the WS handshake authenticates.
 *  - `none`   — ungated backend, no auth param.
 *  - `token`  — static `?token=` (loopback / local-spawn).
 *  - `ticket` — gated via password-login; a fresh single-use `?ticket=` per connect.
 *  - `oauth`  — gated via interactive OAuth; also a per-connect `?ticket=`, but a
 *               mint failure means the session expired → re-open sign-in. */
export type AuthMode = 'none' | 'token' | 'ticket' | 'oauth'

export interface Connection {
  baseUrl: string
  authMode: AuthMode
  /** Present only in token mode. */
  token?: string
  /** Gateway mode. Optional for back-compat; treated as `remote` when absent
   *  until Track E makes it explicit at every construction site. */
  mode?: GatewayMode
  /** Multi-profile selector, threaded into the ws-ticket mint. Null/undefined =
   *  the backend's default profile. */
  profile?: null | string
  /** ssh only: `user@host`, for display. The tunnelled baseUrl is always
   *  `http://127.0.0.1:<ephemeral>`, which tells the user nothing. */
  remoteHost?: string
  /** ssh only: the ownership id — stable across re-tunnels, unlike baseUrl.
   *  See {@link connectionCacheKey}. */
  remoteIdentity?: string
}

/** Cloud reuses the entire remote connect/probe/reconnect path — it differs only
 *  in how `baseUrl` was obtained (portal discovery) and which settings card shows.
 *  Ported from desktop `electron/connection-config.ts` `modeIsRemoteLike`.
 *
 *  `ssh` is deliberately NOT remote-like, matching desktop: the tunnel terminates
 *  at a loopback backend that authenticates with a static token, so it takes the
 *  same path as `local`, not the probe/OAuth path a real remote URL needs. */
export function modeIsRemoteLike(mode: GatewayMode | undefined): boolean {
  return mode === 'remote' || mode === 'cloud' || mode === undefined
}

/**
 * A stable identity for caches keyed on "which backend am I talking to".
 *
 * For every mode but `ssh` the baseUrl is that identity. An ssh connection's
 * baseUrl carries a fresh ephemeral port on every re-tunnel, so keying on it
 * throws away the file tree and directory listings on each reconnect even though
 * the backend is literally the same process. Desktop hit this and fixed it the
 * same way (`src/lib/desktop-fs.ts:24-29`).
 */
export function connectionCacheKey(conn: Connection | null): string {
  if (!conn) {
    return 'none'
  }

  const mode = conn.mode ?? 'remote'
  const profile = conn.profile ?? ''
  const identity =
    mode === 'ssh' ? conn.remoteIdentity || conn.remoteHost || conn.baseUrl : conn.baseUrl

  return `${mode}:${profile}:${identity}`
}

export interface StatusLike {
  auth_required?: boolean
  auth_providers?: string[]
}

/** Coarse gated-vs-ungated read of `/api/status`. A gated backend defaults to the
 *  interactive `oauth` path (matching desktop `authModeFromStatus`); the connect
 *  layer downgrades to `ticket` only when the operator supplies password creds for
 *  a password-capable provider. */
export function authModeFromStatus(status: StatusLike): AuthMode {
  return status.auth_required ? 'oauth' : 'none'
}

export interface GatedAuthChoice {
  authMode: 'oauth' | 'ticket'
  /** Provider name to pass to oauthLogin / passwordLogin. */
  provider: string
}

/** Decide how to satisfy a gated backend. Password-login (→ ticket) wins only when
 *  the operator actually supplied credentials AND a provider supports it; otherwise
 *  we take the interactive OAuth path. Prefers a non-password provider for OAuth,
 *  falling back to the first advertised, else the conventional `nous`. Pure. */
export function chooseGatedAuth(providers: AuthProvider[], hasPasswordCreds: boolean): GatedAuthChoice {
  const passwordProvider = providers.find(p => p.supports_password)

  if (hasPasswordCreds && passwordProvider) {
    return { authMode: 'ticket', provider: passwordProvider.name }
  }

  const oauthProvider = providers.find(p => !p.supports_password) ?? providers[0]

  return { authMode: 'oauth', provider: oauthProvider?.name ?? 'nous' }
}

const WS_PATH = '/api/ws'

/** The mint deps `resolveGatewayWsUrl` needs: a fresh single-use ws-ticket built
 *  from the session cookie the Rust jar holds. Used by both `ticket` and `oauth`. */
export function ticketMintDeps(baseUrl: string): { getGatewayWsUrl: (profile?: null | string) => Promise<string> } {
  const u = new URL(baseUrl)

  return {
    getGatewayWsUrl: async (): Promise<string> => {
      const ticket = await mintWsTicket(baseUrl)

      return buildHermesWebSocketUrl({
        protocol: u.protocol,
        host: u.host,
        path: WS_PATH,
        authParam: ['ticket', ticket]
      })
    }
  }
}

/** Build the WS URL for a connect. `ticket`/`oauth` mint a fresh ticket per connect;
 *  `oauth` routes through the vendored `resolveGatewayWsUrl` so a mint failure raises
 *  `GatewayReauthRequiredError` (→ re-open sign-in) rather than silently degrading. */
export async function resolveWsUrl(conn: Connection): Promise<string> {
  const u = new URL(conn.baseUrl)

  const build = (authParam?: readonly [string, string]): string =>
    buildHermesWebSocketUrl({ protocol: u.protocol, host: u.host, path: WS_PATH, authParam })

  switch (conn.authMode) {
    case 'none':
      return build()

    case 'token':
      return conn.token ? build(['token', conn.token]) : build()
    case 'oauth': {
      const wsConn: GatewayWsConnection = { authMode: 'oauth', profile: conn.profile ?? null, wsUrl: build() }

      return resolveGatewayWsUrl(ticketMintDeps(conn.baseUrl), wsConn)
    }

    case 'ticket':

    default:
      // Mint directly and throw on failure (no ticketless fallback — a gated
      // backend would reject it at the handshake anyway).
      return build(['ticket', await mintWsTicket(conn.baseUrl)])
  }
}

const SHELL_PTY_PATH = '/api/shell-pty'

/** Build the WS URL for the right-pane terminal (`/api/shell-pty`), reusing the
 *  gateway's token/ticket/oauth auth exactly. `params` carries terminal query
 *  args (e.g. `{ cwd }`). Mirrors `resolveWsUrl`. */
export async function resolveTerminalWsUrl(conn: Connection, params: Record<string, string> = {}): Promise<string> {
  const u = new URL(conn.baseUrl)

  const build = (authParam?: readonly [string, string]): string =>
    buildHermesWebSocketUrl({ protocol: u.protocol, host: u.host, path: SHELL_PTY_PATH, authParam, params })

  switch (conn.authMode) {
    case 'none':
      return build()

    case 'token':
      return conn.token ? build(['token', conn.token]) : build()
    case 'oauth': {
      const mint = { getGatewayWsUrl: async () => build(['ticket', await mintWsTicket(conn.baseUrl)]) }
      const wsConn: GatewayWsConnection = { authMode: 'oauth', profile: conn.profile ?? null, wsUrl: build() }

      return resolveGatewayWsUrl(mint, wsConn)
    }

    case 'ticket':

    default:
      return build(['ticket', await mintWsTicket(conn.baseUrl)])
  }
}
