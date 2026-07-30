/**
 * The plugin WebSocket door — the live twin of `pluginRest` (which stays in
 * `@/hermes` next to `profileScoped`).
 *
 * Why its own module: `hermes.ts` deliberately imports NO store (see its
 * `_apiProfile` note — the profile is pushed in via `setApiRequestProfile`
 * precisely so that file stays out of the store graph and can't reorder module
 * init). This door needs `$connection`, so it lives here instead. Desktop keeps
 * both in `hermes.ts`; that is the only structural difference.
 */

import { pluginPathSuffix } from '@/hermes'
import { $connection } from '@/store/connection'
import { TauriWebSocket } from '@/transport/tauri-websocket'

/**
 * A WebSocket to this plugin's own backend namespace, scoped exactly like
 * `pluginRest`: `path` is relative to `/api/plugins/<pluginId>` ('/events' → the
 * plugin's own event stream). JSON frames only, auto-reconnect with backoff
 * until disposed.
 *
 * Resolves to a no-op unless the connection carries a `token`. Universal's
 * `token` exists only in token mode; `ticket` and `oauth` modes mint a
 * single-use, core-managed `?ticket=` per connect (store/gateway-config
 * `resolveWsUrl`) which a plugin cannot borrow. That bail is wider than
 * desktop's oauth-only one and is the correct rule here.
 *
 * Treat `ctx.socket` as an accelerator over your polling, never a replacement —
 * every consumer needs a fallback anyway, since a socket can always drop.
 * FIXME(MJX-53/ws-ticket): a plugin-scoped ws ticket would close this gap.
 */
export function pluginSocket(pluginId: string, path: string, onMessage: (data: unknown) => void): () => void {
  const suffix = pluginPathSuffix('pluginSocket', path)

  let socket: null | TauriWebSocket = null
  let disposed = false
  let attempt = 0

  const connect = () => {
    const conn = $connection.get()

    if (disposed || !conn?.token) {
      return
    }

    const base = conn.baseUrl.replace(/^http/, 'ws')
    const join = suffix.includes('?') ? '&' : '?'

    // The Rust-backed socket: it exposes add/removeEventListener and has NO
    // onmessage/onclose property setters, and its default origin is the `null`
    // every universal socket sends.
    const next = new TauriWebSocket(
      `${base}/api/plugins/${pluginId}${suffix}${join}token=${encodeURIComponent(conn.token)}`
    )

    socket = next

    next.addEventListener('message', event => {
      attempt = 0

      try {
        onMessage(JSON.parse(String((event as MessageEvent).data)))
      } catch {
        // Non-JSON frame — plugin streams are JSON by contract; skip it.
      }
    })

    next.addEventListener('close', () => {
      socket = null

      if (!disposed) {
        attempt += 1
        window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** attempt))
      }
    })
  }

  connect()

  return () => {
    disposed = true
    socket?.close()
  }
}
