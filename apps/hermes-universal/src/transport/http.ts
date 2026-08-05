import { invoke } from '@tauri-apps/api/core'

import { spanHttp } from '@/observability/auto/http'

// All REST traffic goes through the Rust `http_request` command (no webview
// fetch → no CORS). This is what the ported `hermesDesktop.api` shim will call.

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface HttpRequestOptions {
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

export async function httpRequest(method: string, url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
  // Spanned HERE rather than at each call site: this is the only
  // `invoke('http_request')` in the app, so wrapping it covers every REST call
  // the frontend makes. Records nothing while tracing is off.
  return spanHttp(method, url, () =>
    invoke<HttpResponse>('http_request', {
      req: {
        method,
        url,
        headers: opts.headers ?? {},
        body: opts.body ?? null,
        timeoutMs: opts.timeoutMs ?? null
      }
    })
  )
}

/** Convenience: JSON GET that throws on non-2xx and parses the body. */
export async function getJson<T>(url: string, opts: HttpRequestOptions = {}): Promise<T> {
  const res = await httpRequest('GET', url, opts)

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  }

  return JSON.parse(res.body) as T
}
