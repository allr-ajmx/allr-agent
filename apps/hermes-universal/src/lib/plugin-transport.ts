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

import { pluginNamespacePath } from '@/hermes'
import { mintWsTicket } from '@/lib/auth'
import { $connection } from '@/store/connection'
import { type Connection } from '@/store/gateway-config'
import { TauriWebSocket } from '@/transport/tauri-websocket'

/**
 * The upgrade credential for a plugin socket, by auth mode — the same shapes
 * the gateway's own `_ws_auth_reason` accepts, because plugin WS routes go
 * through that very gate (`plugins/kanban/dashboard/plugin_api.py` calls
 * `_ws_auth_ok`).
 *
 * A gated gateway rejects `?token=` outright, and only `token` mode carries a
 * `conn.token` at all — so requiring one made `ctx.socket` a permanent no-op on
 * every ticket/oauth gateway, silently degrading plugins like the kanban
 * sample's `task_events` to polling. A ws-ticket is single-use and minted per
 * connect, so a plugin taking one costs the core nothing.
 */
async function pluginSocketAuthParam(conn: Connection): Promise<null | string> {
  switch (conn.authMode) {
    case 'none':
      return null

    case 'token':
      return conn.token ? `token=${encodeURIComponent(conn.token)}` : null

    default:
      return `ticket=${encodeURIComponent(await mintWsTicket(conn.baseUrl))}`
  }
}

/**
 * A WebSocket to this plugin's own backend namespace, scoped exactly like
 * `pluginRest`: `path` is relative to `/api/plugins/<pluginId>` ('/events' → the
 * plugin's own event stream). JSON frames only, auto-reconnect with backoff
 * until disposed.
 *
 * Treat `ctx.socket` as an accelerator over your polling, never a replacement —
 * every consumer needs a fallback anyway, since a socket can always drop, and a
 * ticket mint can fail on an expired session.
 */
export function pluginSocket(pluginId: string, path: string, onMessage: (data: unknown) => void): () => void {
  const namespacePath = pluginNamespacePath('pluginSocket', pluginId, path)

  let socket: null | TauriWebSocket = null
  let disposed = false
  let attempt = 0

  const retry = () => {
    if (disposed) {
      return
    }

    attempt += 1
    window.setTimeout(() => void connect(), Math.min(30_000, 1_000 * 2 ** attempt))
  }

  const connect = async () => {
    const conn = $connection.get()

    if (disposed || !conn) {
      return
    }

    let auth: null | string

    try {
      auth = await pluginSocketAuthParam(conn)
    } catch {
      // Mint failed (expired session, gateway down). Back off and retry — the
      // core socket's own reconnect will re-authenticate the app meanwhile.
      retry()

      return
    }

    // Disposal, or a connection swap, can land during the await.
    if (disposed || $connection.get() !== conn) {
      return
    }

    const base = conn.baseUrl.replace(/^http/, 'ws')
    const join = namespacePath.includes('?') ? '&' : '?'
    const query = auth ? `${join}${auth}` : ''

    // The Rust-backed socket: it exposes add/removeEventListener and has NO
    // onmessage/onclose property setters, and its default origin is the `null`
    // every universal socket sends.
    const next = new TauriWebSocket(`${base}${namespacePath}${query}`)

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
      retry()
    })
  }

  void connect()

  return () => {
    disposed = true
    socket?.close()
  }
}
