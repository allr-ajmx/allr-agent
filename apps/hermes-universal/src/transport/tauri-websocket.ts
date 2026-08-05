import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { spanInboundFrame, spanOutboundFrame } from '@/observability/auto/websocket'

// An IPC-backed WebSocket: the real socket lives in Rust (`transport.rs`), this
// class is just a `WebSocketLike` façade so the reused `JsonRpcGatewayClient`
// can drive it unchanged. It implements exactly the subset that client touches:
// the numeric `readyState` constants, `send`, `close`, and add/removeEventListener
// for 'open' | 'message' | 'close' | 'error' (with `message.data` = the frame text).

type EventListenerLike = (event: { type: string; data?: unknown; message?: string }) => void

// Desktop's chat socket is a Chromium `WebSocket` opened from a file:// renderer,
// so it sends `Origin: null` on the upgrade — the value Hermes gateways accept for
// native clients. We mirror that exactly. Sending the gateway's OWN origin instead
// (what we used to derive from the ws URL) is rejected by gateways/reverse proxies
// that guard the /api/ws upgrade on Origin/Host: behind a proxy the internal Host
// differs from the public origin, so an explicit same-origin value fails the check
// while `null` passes. Auth is the single-use `?ticket=` param, not the Origin.
const NATIVE_ORIGIN = 'null'

export class TauriWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = 0

  private readonly id = crypto.randomUUID()
  private readonly url: string
  private readonly origin?: string
  private readonly listeners = new Map<string, Set<EventListenerLike>>()
  private unlisten: UnlistenFn[] = []
  private sendQueue: string[] = []
  private closed = false

  constructor(url: string, origin?: string) {
    this.url = url
    this.origin = origin
    void this.init()
  }

  private async init(): Promise<void> {
    try {
      const sub = (suffix: string) =>
        listen(`ws://${this.id}/${suffix}`, event => this.onRustEvent(suffix, event.payload))

      this.unlisten = await Promise.all([sub('open'), sub('message'), sub('close'), sub('error')])

      if (this.closed) {
        // close() was called before the socket finished opening.
        void invoke('ws_close', { id: this.id }).catch(() => undefined)
        this.teardown()

        return
      }

      await invoke('ws_open', {
        id: this.id,
        url: this.url,
        origin: this.origin ?? NATIVE_ORIGIN
      })

      const queued = this.sendQueue
      this.sendQueue = []

      for (const text of queued) {
        void invoke('ws_send', { id: this.id, text }).catch(() => undefined)
      }
    } catch (err) {
      this.dispatch('error', { message: err instanceof Error ? err.message : String(err) })
      this.readyState = this.CLOSED
      this.dispatch('close', {})
      this.teardown()
    }
  }

  private onRustEvent(kind: string, payload: unknown): void {
    switch (kind) {
      case 'open':
        this.readyState = this.OPEN
        this.dispatch('open', {})

        break

      case 'message':
        // The span covers DISPATCH, not arrival: listeners run synchronously
        // off this, and on the streaming path they are the whole chat pipeline.
        // A large gap on a `ws.message` span therefore means time spent
        // reacting to the frame, which is the question worth asking of a slow
        // stream.
        spanInboundFrame(payload, () => this.dispatch('message', { data: payload }))

        break

      case 'close':
        this.readyState = this.CLOSED
        this.dispatch('close', {})
        this.teardown()

        break

      case 'error':
        this.dispatch('error', { message: String(payload) })

        break
    }
  }

  private dispatch(type: string, extra: { data?: unknown; message?: string }): void {
    const set = this.listeners.get(type)

    if (!set) {
      return
    }

    for (const handler of [...set]) {
      handler({ type, ...extra })
    }
  }

  private teardown(): void {
    for (const off of this.unlisten) {
      try {
        off()
      } catch {
        // ignore
      }
    }

    this.unlisten = []
  }

  addEventListener(type: string, handler: EventListenerLike): void {
    let set = this.listeners.get(type)

    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }

    set.add(handler)
  }

  removeEventListener(type: string, handler: EventListenerLike): void {
    this.listeners.get(type)?.delete(handler)
  }

  send(text: string): void {
    spanOutboundFrame(text, () => {
      if (this.readyState === this.OPEN) {
        void invoke('ws_send', { id: this.id, text }).catch(() => undefined)
      } else {
        this.sendQueue.push(text)
      }
    })
  }

  close(): void {
    this.closed = true

    if (this.readyState === this.CLOSED) {
      return
    }

    this.readyState = this.CLOSING
    void invoke('ws_close', { id: this.id })
      .catch(() => undefined)
      .finally(() => {
        this.readyState = this.CLOSED
        this.teardown()
      })
  }
}
