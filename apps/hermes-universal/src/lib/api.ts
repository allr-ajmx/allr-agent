import { $connection } from '@/store/connection'
import { httpRequest, type HttpUpload } from '@/transport/http'

// REST helper scoped to the active connection. Mirrors the desktop's
// `window.hermesDesktop.api({ path, method, body })` so ported desktop code can
// call it unchanged — but every call runs through the Rust `http_request`
// command (no webview fetch → no CORS), with the session token attached here.

export interface ApiRequest {
  path: string
  method?: string
  body?: unknown
  /** Single-file multipart upload; mutually exclusive with `body`. */
  upload?: HttpUpload
  timeoutMs?: number
  // Threaded into a `?profile=` query (E7.a). The ported desktop REST client
  // (src/hermes.ts) merges { profile } into every profileScoped() call; the
  // backend scopes that request to the named profile's HERMES_HOME
  // (web_server.py _profile_scope). null/"current" = the gateway's own profile.
  profile?: string | null
}

// Append ?profile= to the request path when a non-default profile is set,
// merging with any existing query string.
function withProfile(path: string, profile?: string | null): string {
  const p = profile?.trim()

  if (!p || p === 'current') {
    return path
  }

  const sep = path.includes('?') ? '&' : '?'

  return `${path}${sep}profile=${encodeURIComponent(p)}`
}

export async function api<T = unknown>({
  path,
  method = 'GET',
  body,
  upload,
  timeoutMs,
  profile
}: ApiRequest): Promise<T> {
  const conn = $connection.get()

  if (!conn) {
    throw new Error('Not connected to a Hermes backend')
  }

  const headers: Record<string, string> = {}

  // No Content-Type for an upload: reqwest sets `multipart/form-data` with the
  // boundary it generated, and ours would name a boundary the body doesn't use.
  if (body !== undefined && !upload) {
    headers['Content-Type'] = 'application/json'
  }

  if (conn.token) {
    headers['X-Hermes-Session-Token'] = conn.token
  }

  const res = await httpRequest(method, `${conn.baseUrl}${withProfile(path, profile)}`, {
    headers,
    body,
    upload,
    timeoutMs
  })

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
  }

  return (res.body ? JSON.parse(res.body) : undefined) as T
}
