/**
 * The host (with port) a gateway URL points at, for a status line — or `null` when there is
 * nothing to show. Tolerates a bare `host[:port][/path]` (an older saved target), and falls back
 * to stripping the scheme and path by hand when the URL does not parse.
 */
export function gatewayHostOf(url?: null | string): null | string {
  if (!url) {
    return null
  }

  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).host
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null
  }
}
