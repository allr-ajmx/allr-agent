import { invoke } from '@tauri-apps/api/core'

import { spanHttp } from '@/observability/auto/http'

// All REST traffic goes through the Rust `http_request` command (no webview
// fetch → no CORS). This is what the ported `hermesDesktop.api` shim will call.

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * A single-file `multipart/form-data` upload, sent under the field name `file`
 * — what FastAPI's `UploadFile` parameters expect.
 *
 * The bytes cross the Tauri boundary base64-encoded: that boundary is JSON,
 * where a byte array serialises as a list of numbers roughly 4x the size.
 */
export interface HttpUpload {
  filename: string
  contentType?: string
  bytes: ArrayBuffer
}

export interface HttpRequestOptions {
  headers?: Record<string, string>
  body?: unknown
  /** Mutually exclusive with `body`; a multipart request carries no JSON body. */
  upload?: HttpUpload
  timeoutMs?: number
}

/** Chunked rather than `String.fromCharCode(...all)`, which blows the argument
 *  limit and throws on any attachment past a few hundred KB. */
export function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  const CHUNK = 0x8000
  let binary = ''

  for (let offset = 0; offset < view.length; offset += CHUNK) {
    binary += String.fromCharCode(...view.subarray(offset, offset + CHUNK))
  }

  return btoa(binary)
}

export async function httpRequest(method: string, url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
  const upload = opts.upload
    ? {
        filename: opts.upload.filename,
        contentType: opts.upload.contentType ?? null,
        bytesBase64: bytesToBase64(opts.upload.bytes)
      }
    : null

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
        upload,
        timeoutMs: opts.timeoutMs ?? null
      }
    })
  )
}

/**
 * The part of a URL safe to name in an error the UI will render.
 *
 * A gateway URL's query is credential material — `?token=` (local/SSH) or a
 * per-connect `?ticket=` — so an error that quotes the URL whole hands the
 * credential to every sink the message reaches. The Rust side scrubs its own
 * errors (`transport.rs::redact_error`); this is the same rule for the errors
 * this file raises. Dropping the query outright rather than scrubbing per key:
 * nothing here needs a query param to diagnose a failed GET.
 */
export function urlForError(url: string): string {
  const [head] = url.split('?')

  return head
}

/** Convenience: JSON GET that throws on non-2xx and parses the body. */
export async function getJson<T>(url: string, opts: HttpRequestOptions = {}): Promise<T> {
  const res = await httpRequest('GET', url, opts)

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${urlForError(url)} → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  }

  return JSON.parse(res.body) as T
}
