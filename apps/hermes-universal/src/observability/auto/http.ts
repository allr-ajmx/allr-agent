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

import { spanAsync } from '../span'

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

/**
 * `spanAsync`, not `span`, and that distinction is load-bearing.
 *
 * This used to open a stack-pushed span and hold it across the `await`. A
 * synchronous LIFO cannot describe an in-flight request: every unrelated span
 * opened while the round trip was outstanding became a child of it, and closing
 * it truncated the stack out from under spans that were legitimately open. A
 * detached span records the same interval and gets its parent from where the
 * call was MADE, which is the honest answer.
 */
export function spanHttp<T>(method: string, url: string, run: () => Promise<T>): Promise<T> {
  return spanAsync('http.request', run, { method, path: safeUrl(url) })
}
