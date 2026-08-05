/**
 * HTTP autocapture.
 *
 * `transport/http.ts` is the only `invoke('http_request')` call site in the app
 * — every REST call reaches it through `lib/api.ts` — so one wrapper here spans
 * all of them with no per-call-site code. (The single remaining `fetch()` in the
 * app decodes a `data:` URL and is not network traffic.)
 *
 * Ships. A slow request is exactly the thing a user's trace should explain, and
 * it costs nothing while recording is off.
 */

import { beginSpan, endSpan } from '../span'

/**
 * Strip a URL down to something safe to put in a span.
 *
 * Query strings and fragments carry tokens, session ids and search terms; the
 * origin can carry a self-hosted gateway's hostname. A span attribute may end
 * up in a shared trace or a bug report, so this keeps the PATH — which is what
 * identifies the endpoint — and drops the rest.
 */
export function safeUrl(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    // Relative or malformed: keep everything before the query.
    return url.split('?')[0]
  }
}

export async function spanHttp<T>(method: string, url: string, run: () => Promise<T>): Promise<T> {
  const id = beginSpan('http.request', { method, path: safeUrl(url) })

  try {
    const result = await run()

    endSpan(id)

    return result
  } catch (error) {
    // Close the span before rethrowing, and mark it — a failed request that
    // simply vanished from the trace is worse than no instrumentation, because
    // the gap it leaves looks like idle time.
    endSpan(id, { error: 'true' })

    throw error
  }
}
