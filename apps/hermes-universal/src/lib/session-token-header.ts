// The token-mode session header, in both spellings the gateway may know it by.
//
// The name is an on-wire contract with a gateway that ships on its own schedule: a
// build from before the Allr rename accepts only `X-Hermes-Session-Token`, a current
// one reads `X-Allr-Session-Token`. This app has to authenticate to either, and it
// cannot ask first — the header goes out on the very first request.
//
// So it sends both. They carry the same value, an unknown header is ignored by every
// server, and the cost is a few dozen bytes per request. The alternative is a probe
// round trip on every connect to learn which name to use, for a header that is
// already the cheapest thing in the request.

/** Canonical name. Current gateways read this one. */
export const SESSION_TOKEN_HEADER = 'X-Allr-Session-Token'

/** Pre-rebrand gateways read this one, and nothing else. */
export const LEGACY_SESSION_TOKEN_HEADER = 'X-Hermes-Session-Token' // rebrand:keep

/**
 * Headers that authenticate `token` against a gateway of either vintage.
 *
 * Returns an empty object for a missing/blank token so callers can spread it
 * unconditionally rather than branching at every call site.
 */
export function sessionTokenHeaders(token: null | string | undefined): Record<string, string> {
  if (!token) {
    return {}
  }

  return {
    [SESSION_TOKEN_HEADER]: token,
    [LEGACY_SESSION_TOKEN_HEADER]: token
  }
}
