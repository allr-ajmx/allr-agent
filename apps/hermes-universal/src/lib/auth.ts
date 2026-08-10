import { invoke } from '@tauri-apps/api/core'

import { authHeaders, resolveOauthRestAuth } from '@/lib/native-auth-decisions'
import { httpRequest } from '@/transport/http'

// Gated-mode auth (auth_required=true). All requests run through the Rust
// transport, whose reqwest client has a cookie jar — so the session cookie set
// by password-login is automatically carried into the ws-ticket POST. We set an
// explicit Origin (a native client has none by default) so the gated middleware
// accepts the state-changing POSTs.
//
// A gateway that advertises `native_pkce` is signed into via RFC 8252 instead
// (system browser + PKCE + loopback, run entirely in src-tauri/src/oauth.rs),
// and that session has NO cookie — it authenticates with
// `Authorization: Bearer`. The gated middleware accepts a bearer on every
// non-public route, ws-ticket included, so the only thing that changes on this
// side is which credential the mint presents.

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

/**
 * Last bearer the Rust side handed us, per gateway base. Populated as a side
 * effect of `oauthStatus`, which `connect()` already calls on the OAuth path —
 * so the common case costs no extra round trip, and a password/ticket gateway
 * simply never has an entry.
 *
 * `null` is a real value: it records "we asked, and there is no native session",
 * which is what stops the mint from re-probing on every reconnect.
 */
const nativeBearers = new Map<string, null | string>()

function normalizeAuthBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/** Forget a gateway's cached bearer (sign-out, or a bearer the gateway refused). */
export function forgetNativeBearer(base: string): void {
  nativeBearers.delete(normalizeAuthBase(base))
}

/**
 * The bearer for a gateway, asking Rust when we have never looked. Rust owns the
 * refresh, so a returned token is current; a failure degrades to the cookie path
 * rather than blocking the connect.
 */
async function nativeBearerFor(base: string, { refresh = false } = {}): Promise<null | string> {
  const key = normalizeAuthBase(base)

  if (!refresh && nativeBearers.has(key)) {
    return nativeBearers.get(key) ?? null
  }

  try {
    const status = await oauthStatus(key)

    return nativeBearers.get(key) ?? status.nativeAccessToken ?? null
  } catch {
    nativeBearers.set(key, null)

    return null
  }
}

/**
 * POST /api/auth/ws-ticket → single-use 30s ticket for the WS upgrade.
 *
 * Presents the native bearer when one exists, else the cookie jar (which the
 * Rust transport attaches on its own) — desktop's `resolveOauthRestAuth` rule.
 * A 401 while holding a bearer re-resolves ONCE before giving up: the stored
 * access token can expire between the connect probe and the mint, and Rust's
 * `oauth_status` rotates it, so one retry turns a spurious "sign in again" into
 * a silent success.
 */
export async function mintWsTicket(base: string): Promise<string> {
  const attempt = async (bearer: null | string) =>
    httpRequest('POST', `${base}/api/auth/ws-ticket`, {
      headers: { Origin: base, ...authHeaders(resolveOauthRestAuth(bearer)) },
      timeoutMs: 10_000
    })

  const bearer = await nativeBearerFor(base)
  let res = await attempt(bearer)

  if (res.status === 401 && bearer) {
    const rotated = await nativeBearerFor(base, { refresh: true })

    if (rotated && rotated !== bearer) {
      res = await attempt(rotated)
    }
  }

  if (res.status === 401) {
    throw new Error('Session expired — sign in again')
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
 * `native_pkce` the Rust command takes the RFC 8252 path (system browser, PKCE,
 * loopback listener, bearer into the OS keyring) and never opens a webview;
 * otherwise it falls back to the legacy webview-cookie cascade. Either way the
 * caller connects normally afterwards — the credential difference is invisible
 * from here except through `oauthStatus().nativeAccessToken`.
 */
export async function oauthLogin(base: string, provider?: string): Promise<void> {
  forgetNativeBearer(base)
  await invoke('oauth_login', { base, provider: provider ?? null })
}

export interface OauthStatus {
  signedIn: boolean
  email?: string | null
  displayName?: string | null
  /** The RFC 8252 bearer, when this gateway has a live native session. Absent
   *  for a cookie session — see `resolveOauthRestAuth`. */
  nativeAccessToken?: null | string
}

/**
 * Whether a live gateway session exists — native bearer OR cookie jar
 * (`oauthSessionIsLive`). Rust decides, and refreshes an expiring bearer while
 * it is there, so this doubles as the "give me a current bearer" call; the
 * result is cached for the ws-ticket mint.
 */
export async function oauthStatus(base: string): Promise<OauthStatus> {
  const status = await invoke<OauthStatus>('oauth_status', { base })

  nativeBearers.set(normalizeAuthBase(base), status.nativeAccessToken ?? null)

  return status
}

/** Sign out (POST /auth/logout); drops the native tokens and clears the session
 *  cookie from the shared jar. */
export async function oauthLogout(base: string): Promise<void> {
  forgetNativeBearer(base)
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
