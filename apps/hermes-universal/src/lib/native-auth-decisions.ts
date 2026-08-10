/**
 * The RFC 8252 native-auth contract, as pure decisions (MJXHRM-77).
 *
 * Ported from `apps/desktop/electron/native-auth-decisions.ts`, where each of
 * these was extracted after a real runtime bug. Universal's version is
 * deliberately SHORTER than desktop's, because two of desktop's five seams
 * cannot happen here and a verbatim copy would be five lies:
 *
 *   * `resolveJsonBody` — desktop double-encoded its token POST body into a JSON
 *     string and got a 422 back. Universal never builds that body in JS; the
 *     token/refresh POSTs are made by `src-tauri/src/oauth.rs` with reqwest's
 *     `.json()`, so there is no seam to pin.
 *   * `resolveReadinessProbeAuth` — desktop's boot probe hit `/api/health`
 *     without credentials and 401'd forever against a gated gateway. Universal
 *     reads readiness over the ALREADY-AUTHENTICATED websocket
 *     (`setup.status` / `setup.runtime_check`), so it has no credential-free
 *     probe to get wrong.
 *
 * What does port is the bearer-vs-cookie choice, the liveness rule, and the
 * guard — the three that describe how a native session and a cookie session
 * coexist.
 */

/** The capability token `/api/status` advertises in `auth_flows` when the
 *  gateway can broker a native-app login. Mirrors `NATIVE_FLOW_ID` in
 *  `src-tauri/src/oauth.rs` and `hermes_cli/web_server.py`. */
export const NATIVE_FLOW_ID = 'native_pkce'

export interface StatusAuthFlows {
  auth_flows?: string[]
}

/**
 * Can this gateway broker an RFC 8252 native login?
 *
 * Absent or malformed ⇒ `false`. That is the compatibility mechanism, not a
 * defensive check: a gateway older than the native routes simply never lists the
 * flow, so every client falls back to the cookie path without a version compare.
 */
export function statusSupportsNativeFlow(status: null | StatusAuthFlows | undefined): boolean {
  return Array.isArray(status?.auth_flows) && status.auth_flows.includes(NATIVE_FLOW_ID)
}

/**
 * True when a gated gateway should be treated as signed in. Either credential
 * suffices.
 *
 * Gating on the cookie alone is desktop's bug #2 and it is worth restating,
 * because a native login leaves NO cookie at all: a cookie-only liveness check
 * reports "signed out" immediately after a successful sign-in and sends the user
 * back to the browser on every single connect.
 */
export function oauthSessionIsLive(hasNativeToken: boolean, hasCookieSession: boolean): boolean {
  return hasNativeToken || hasCookieSession
}

export type OauthRestAuth = { kind: 'bearer'; token: string } | { kind: 'cookie' }

/**
 * How an oauth-mode request authenticates: the native bearer when we hold one,
 * otherwise the shared cookie jar. `nativeAccessToken` is whatever the Rust side
 * last resolved — null/empty when there is no native session or its refresh
 * terminally failed.
 */
export function resolveOauthRestAuth(nativeAccessToken: null | string | undefined): OauthRestAuth {
  if (nativeAccessToken) {
    return { kind: 'bearer', token: nativeAccessToken }
  }

  return { kind: 'cookie' }
}

/** The `Authorization` header for a resolved auth choice, or nothing for the
 *  cookie path (the Rust transport attaches the jar itself). */
export function authHeaders(auth: OauthRestAuth): Record<string, string> {
  return auth.kind === 'bearer' ? { Authorization: `Bearer ${auth.token}` } : {}
}

export interface AdvertisedAuthProvider {
  name?: string
  supports_password?: boolean
}

/**
 * Whether a "not signed in" pre-flight may hard-fail the connection.
 *
 * `auth_required: true` means the gateway is GATED — it says nothing about how
 * you authenticate. A gateway whose providers are all username/password can
 * satisfy neither the bearer nor the OAuth-cookie check by construction
 * (`start_login` is not implemented for them and `/auth/native/authorize`
 * rejects them outright), so hard-failing there would reject a live session one
 * line before the ws-ticket mint that would have succeeded.
 *
 * Universal already routes around this in `chooseGatedAuth`, which picks
 * password-login → ticket whenever creds exist and a provider supports it. This
 * is the same rule stated once, for any future caller that only has the provider
 * list. Returns false only when EVERY advertised provider is password-based; an
 * unknown or empty list keeps the strict answer, so backends predating
 * `/api/auth/providers` are unaffected.
 */
export function oauthGuardMayHardFail(providers: AdvertisedAuthProvider[] | null | undefined): boolean {
  if (!Array.isArray(providers) || providers.length === 0) {
    return true
  }

  const named = providers.filter(provider => provider && typeof provider === 'object' && provider.name)

  if (named.length === 0) {
    return true
  }

  return !named.every(provider => provider.supports_password)
}
