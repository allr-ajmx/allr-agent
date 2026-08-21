import { invoke } from '@tauri-apps/api/core'
import { atom } from 'nanostores'

import { GatewayReauthRequiredError } from '@/gateway'
import { httpRequest } from '@/transport/http'

// Gated-mode auth (auth_required=true). All requests run through the Rust
// transport, whose reqwest client has a cookie jar — so the session cookie set
// by password-login is automatically carried into the ws-ticket POST. We set an
// explicit Origin (a native client has none by default) so the gated middleware
// accepts the state-changing POSTs.
//
// A gateway that advertises `native_pkce` is signed into via RFC 8252 instead
// (PKCE + a loopback listener, run entirely in src-tauri/src/oauth.rs — the system
// browser on desktop, the calling webview on mobile), and that session has NO
// cookie — it authenticates with
// `Authorization: Bearer`. That header is attached by src-tauri/src/transport.rs
// from the OS keyring, on the same request this file asks for; the bearer never
// crosses IPC and nothing here has to know which credential is in play
// (MJXHRM-354). Both session kinds therefore look identical from JS: ask for the
// request, get the response.

/** POST /auth/password-login → session cookie (held in the Rust cookie jar). */
export async function passwordLogin(
  base: string,
  username: string,
  password: string,
  provider = 'basic'
): Promise<void> {
  const res = await httpRequest('POST', `${base}/auth/password-login`, {
    headers: { Origin: base },
    body: { provider, username, password, next: '' },
    timeoutMs: 10_000
  })

  if (res.status === 401) {
    throw new Error('Invalid username or password')
  }

  if (res.status === 404) {
    throw new Error('This backend has no password login enabled')
  }

  if (res.status === 429) {
    throw new Error('Too many login attempts — try again shortly')
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Login failed (HTTP ${res.status})`)
  }
}

function normalizeAuthBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/**
 * POST /api/auth/ws-ticket → single-use 30s ticket for the WS upgrade.
 *
 * Carries no credential of its own. Whichever one this gateway uses — the
 * session cookie or the RFC 8252 bearer — is attached by the Rust transport,
 * including the rotate-and-retry when the gateway answers 401 because the access
 * token expired between the connect probe and this mint. A 401 that reaches here
 * has already survived that rotation, so it means what it says.
 */
export async function mintWsTicket(base: string): Promise<string> {
  const res = await httpRequest('POST', `${base}/api/auth/ws-ticket`, {
    headers: { Origin: base },
    timeoutMs: 10_000
  })

  // Typed, not a bare Error. A 401 here is the one failure a caller can DO
  // something about, and every caller has to agree on how to spot it: the
  // connect retry (store/connection.ts), the reconnect supervisor's auth budget,
  // and the mobile stand-down all branch on `isGatewayReauthRequired`. The
  // `ticket` arm of `resolveWsUrl` mints directly rather than through
  // `resolveGatewayWsUrl`, so it used to raise a plain Error that none of them
  // recognised — a password gateway's expiry was therefore retried forever on the
  // network ladder instead of being reported as a dead credential.
  if (res.status === 401) {
    throw new GatewayReauthRequiredError('Session expired — sign in again')
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Could not obtain a WebSocket ticket (HTTP ${res.status})`)
  }

  const data = JSON.parse(res.body) as { ticket?: string }

  if (!data.ticket) {
    throw new Error('ws-ticket response missing ticket')
  }

  return data.ticket
}

// ---------------------------------------------------------------------------
// Connection-level OAuth (Track D). The interactive flow + cookie capture live
// in Rust (src-tauri/src/oauth.rs); these are the typed JS bindings.
// ---------------------------------------------------------------------------

export interface AuthProvider {
  name: string
  display_name: string
  supports_password: boolean
}

/** GET /api/auth/providers → the interactive sign-in options a gated backend
 *  advertises. Returns [] when none are registered (503) so callers can fall
 *  back to the default provider. */
export async function fetchAuthProviders(base: string): Promise<AuthProvider[]> {
  const res = await httpRequest('GET', `${base}/api/auth/providers`, { timeoutMs: 8_000 })

  if (res.status === 503) {
    return []
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Could not load auth providers (HTTP ${res.status})`)
  }

  const data = JSON.parse(res.body) as { providers?: AuthProvider[] }

  return data.providers ?? []
}

/**
 * Run the interactive gateway sign-in in Rust.
 *
 * Which flow runs is the gateway's call, not ours: when `/api/status` advertises
 * `native_pkce` the Rust command takes the RFC 8252 path (PKCE, loopback listener,
 * bearer into the OS keyring); otherwise it falls back to the legacy webview-cookie
 * cascade. Either way the caller connects normally afterwards — the credential
 * difference is invisible from here except as `oauthStatus().sessionKind`.
 *
 * Where the user types their password differs by platform, and that difference is
 * why this may never resolve. Desktop opens a dedicated sign-in WINDOW beside the app,
 * so nothing here is disturbed and this resolves normally. Mobile drives the CALLING
 * webview to the login and back, because neither phone can host a dismissable second
 * window (see src-tauri/src/oauth.rs). So on mobile BOTH flows destroy this JS context,
 * and `beginOAuthLogin` parks a resume marker before calling either.
 *
 * Neither platform uses the system browser: nothing in this project registers a URL
 * scheme, so a browser that fails to reach our loopback listener has no way back.
 */
export async function oauthLogin(base: string, provider?: string): Promise<void> {
  await invoke('oauth_login', { base, provider: provider ?? null })
}

/** Which credential backs a live gateway session. `native` is the RFC 8252
 *  bearer (OS keyring, attached in Rust); `cookie` is the shared reqwest jar. */
export type OauthSessionKind = 'cookie' | 'native'

export interface OauthStatus {
  signedIn: boolean
  email?: string | null
  displayName?: string | null
  /** How the live session authenticates, or absent when signed out. The
   *  credential itself never crosses IPC — `src-tauri/src/transport.rs` reads it
   *  from the keyring and attaches it per request (MJXHRM-354). */
  sessionKind?: null | OauthSessionKind
}

/**
 * The session kind the last probe saw, and the gateway it belongs to.
 *
 * Exists so the UI can say WHICH way you are signed in, now that a native
 * session and a cookie session look identical from every other angle. Keyed by
 * base because the live session belongs to one gateway: a reader comparing this
 * against the gateway it is rendering cannot show a stale "signed in" for the
 * one it is leaving.
 */
export const $oauthSession = atom<{ base: string; kind: OauthSessionKind } | null>(null)

function rememberSession(base: string, kind: null | OauthSessionKind | undefined): void {
  const key = normalizeAuthBase(base)

  if (kind) {
    $oauthSession.set({ base: key, kind })

    return
  }

  // Signed out. Only clear what this probe actually spoke for — a probe of some
  // OTHER gateway says nothing about the session we are holding.
  if ($oauthSession.get()?.base === key) {
    $oauthSession.set(null)
  }
}

/**
 * Whether a live gateway session exists — native bearer OR cookie jar
 * (`oauthSessionIsLive`). Rust decides, and refreshes an expiring bearer while
 * it is there.
 */
export async function oauthStatus(base: string): Promise<OauthStatus> {
  const status = await invoke<OauthStatus>('oauth_status', { base })

  rememberSession(base, status.signedIn ? status.sessionKind : null)

  return status
}

/** Sign out (POST /auth/logout); drops the native tokens and clears the session
 *  cookie from the shared jar. */
export async function oauthLogout(base: string): Promise<void> {
  rememberSession(base, null)
  await invoke('oauth_logout', { base })
}

/** Clear the Nous portal (Privy) session held in the portal webview. Best-effort. */
export async function portalLogout(): Promise<void> {
  await invoke('portal_logout')
}

/** Silent SSO into a cloud agent's gateway using the live portal session. */
export async function portalAgentSignIn(dashboardUrl: string): Promise<{ connected: boolean; baseUrl: string }> {
  return invoke<{ connected: boolean; baseUrl: string }>('portal_agent_sign_in', { dashboardUrl })
}
