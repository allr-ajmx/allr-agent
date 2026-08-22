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
import { reconnectBackoffDelayMs } from '@/lib/reconnect-backoff'
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
 * It FOLLOWS `$connection` for the same reason `pluginRest` reads it per call:
 * plugins register once, at module init (`discoverBundledPlugins()` runs from
 * `app/contrib/controller.tsx`'s module body, and `main.tsx` only dials
 * afterwards), so at `ctx.socket()` time there is normally no connection at
 * all — and a gateway switch is a soft re-home in place
 * (`store/gateway-soft-switch.ts`), never a reload. Without the subscription
 * this door opened nothing on a cold boot and, once open, kept streaming the
 * PREVIOUS gateway's data into a plugin whose REST calls had already moved.
 *
 * Treat `ctx.socket` as an accelerator over your polling, never a replacement —
 * every consumer needs a fallback anyway, since a socket can always drop, and a
 * ticket mint can fail on an expired session.
 */
export function pluginSocket(pluginId: string, path: string, onMessage: (data: unknown) => void): () => void {
  const namespacePath = pluginNamespacePath('pluginSocket', pluginId, path)

  let socket: null | TauriWebSocket = null
  // The connection `socket` was opened against — the credential in its URL and
  // every frame it carries belong to that gateway, not to whatever is current.
  let bound: Connection | null = null
  let disposed = false
  let attempt = 0
  let timer: null | number = null

  const clearTimer = () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  const drop = () => {
    const live = socket

    socket = null
    bound = null
    live?.close()
  }

  const retry = () => {
    if (disposed) {
      return
    }

    clearTimer()
    // Full jitter, like every other reconnect ladder in the app: a bare
    // exponential has N clients of one gateway redialling in lockstep after it
    // restarts, and each attempt here also costs a `POST /api/auth/ws-ticket`.
    timer = window.setTimeout(
      () => {
        timer = null
        void connect()
      },
      reconnectBackoffDelayMs(attempt, { baseDelayMs: 500, capMs: 30_000 })
    )
    attempt += 1
  }

  const connect = async () => {
    const conn = $connection.get()

    // No connection yet, or one already live: the `$connection` subscription
    // below is what wakes this up, so neither case schedules a retry.
    if (disposed || !conn || socket) {
      return
    }

    let auth: null | string

    try {
      auth = await pluginSocketAuthParam(conn)
    } catch {
      // Mint failed (expired session, gateway down). Back off and retry — the
      // core socket's own reconnect will re-authenticate the app meanwhile.
      // Unless the gateway moved under us, in which case the subscription has
      // already redialled and a second ladder would just double the traffic.
      if ($connection.get() === conn) {
        retry()
      }

      return
    }

    // Disposal, or a connection swap, can land during the await.
    if (disposed || socket || $connection.get() !== conn) {
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
    bound = conn

    // Reset on the HANDSHAKE, not on the first frame: a plugin stream can be
    // legitimately silent for hours (the kanban sample's `/events` sends
    // nothing until a task moves), so resetting on `message` left a socket that
    // reconnects perfectly stuck at the 30s ceiling forever.
    next.addEventListener('open', () => {
      attempt = 0
    })

    next.addEventListener('message', event => {
      try {
        onMessage(JSON.parse(String((event as MessageEvent).data)))
      } catch {
        // Non-JSON frame — plugin streams are JSON by contract; skip it.
      }
    })

    next.addEventListener('close', () => {
      // Guarded: a re-home closed this socket itself and has already redialled.
      if (socket !== next) {
        return
      }

      socket = null
      bound = null
      retry()
    })
  }

  // Re-home on every connection change — including the first one, which is
  // what makes this door work at all (see the note above).
  const unlisten = $connection.listen(conn => {
    if (disposed || bound === conn) {
      return
    }

    if (bound) {
      drop()
    }

    attempt = 0
    clearTimer()

    if (conn) {
      void connect()
    }
  })

  void connect()

  return () => {
    disposed = true
    unlisten()
    clearTimer()
    drop()
  }
}
