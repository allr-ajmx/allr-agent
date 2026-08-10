import { Channel, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// A binary-capable socket for the right-pane terminal and for streaming TTS,
// reusing the Rust ws_open/ws_send/ws_close commands (transport.rs). Keystrokes
// + the `\x1b[RESIZE:cols;rows]` escape go out as UTF-8 text (ws_send); output
// arrives as text frames (the `/message` event) AND raw byte frames.
//
// Byte frames come back over a `Channel`, NOT an event: a Tauri event is JSON,
// so bytes would cross IPC as `[12,255,3,…]` and be re-packed element by element
// here — ~115 KB of JSON parsing per second of speech, on the main thread. A
// channel delivers an `ArrayBuffer` instead. See transport.rs for the full note.
//
// Kept separate from TauriWebSocket (the JSON-RPC gateway socket) so binary
// frames never reach the gateway client.

function deriveOrigin(wsUrl: string): string | undefined {
  try {
    const u = new URL(wsUrl)

    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
  } catch {
    return undefined
  }
}

/** The `/close` payload is `{code, reason}` (transport.rs), but a bare number is
 *  what older Rust cores emit — a desktop app can outlive its bundled core across
 *  a JS-only hot update, so both shapes stay readable. */
function parseClosePayload(payload: unknown): { code?: number; reason?: string } {
  if (typeof payload === 'number') {
    return { code: payload }
  }

  if (payload && typeof payload === 'object') {
    const { code, reason } = payload as { code?: unknown; reason?: unknown }

    return {
      code: typeof code === 'number' ? code : undefined,
      reason: typeof reason === 'string' && reason.trim() ? reason : undefined
    }
  }

  return {}
}

/** Normalise whatever a binary frame arrived as into bytes.
 *
 *  Three shapes are live at once: an `ArrayBuffer` from the channel (both the
 *  direct-eval and the queued-fetch path Tauri picks between by size), a view
 *  if a future runtime hands one over, and a plain number array from the LEGACY
 *  `/binary` event that an older Rust core still emits.
 *
 *  Length is preserved exactly, including zero — `lib/tts.ts` carries a trailing
 *  byte into the next frame when a frame's length is odd, so a dropped or padded
 *  byte desynchronises int16 PCM for the rest of the reply. */
function toBytes(message: unknown): Uint8Array {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message)
  }

  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
  }

  if (Array.isArray(message)) {
    return Uint8Array.from(message as number[])
  }

  return new Uint8Array(0)
}

export interface TerminalSocketHandlers {
  onBinary: (bytes: Uint8Array) => void
  /** `code` is the WS close code (e.g. 4401 auth, 4410 child-exit) or undefined.
   *  `reason` is the server's close-frame text when it sent one — for a 4404 that
   *  is the sentence explaining WHY, which the pane shows under its headline. */
  onClose: (code?: number, reason?: string) => void
  onError: (message: string) => void
  onOpen: () => void
  onText: (text: string) => void
}

export class TerminalSocket {
  private readonly id = crypto.randomUUID()
  private readonly origin?: string
  private unlisten: UnlistenFn[] = []
  private open = false
  private closed = false

  constructor(
    private readonly url: string,
    private readonly handlers: TerminalSocketHandlers
  ) {
    this.origin = deriveOrigin(url)
    void this.init()
  }

  private async init(): Promise<void> {
    try {
      const sub = (suffix: string, cb: (payload: unknown) => void) =>
        listen(`ws://${this.id}/${suffix}`, event => cb(event.payload))

      // Created before `ws_open` so the reader task has it from its first frame.
      const binary = new Channel<ArrayBuffer>()

      binary.onmessage = message => this.handlers.onBinary(toBytes(message))

      this.unlisten = await Promise.all([
        sub('open', () => {
          this.open = true
          this.handlers.onOpen()
        }),
        sub('message', payload => this.handlers.onText(typeof payload === 'string' ? payload : String(payload))),
        // Compatibility only: a Rust core that predates `binaryChannel` ignores
        // the extra argument and still emits this event. A core that honours the
        // channel never emits it, so there is no double delivery.
        sub('binary', payload => this.handlers.onBinary(toBytes(payload))),
        sub('close', payload => {
          this.open = false

          const { code, reason } = parseClosePayload(payload)

          this.handlers.onClose(code, reason)
        }),
        sub('error', payload => this.handlers.onError(String(payload)))
      ])

      if (this.closed) {
        void invoke('ws_close', { id: this.id }).catch(() => undefined)
        this.teardown()

        return
      }

      await invoke('ws_open', { binaryChannel: binary, id: this.id, origin: this.origin, url: this.url })
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
      this.handlers.onClose()
      this.teardown()
    }
  }

  /** Send a UTF-8 string frame (keystrokes or the resize escape). */
  sendText(text: string): void {
    if (this.open) {
      void invoke('ws_send', { id: this.id, text }).catch(() => undefined)
    }
  }

  get isOpen(): boolean {
    return this.open
  }

  close(): void {
    this.closed = true
    this.open = false
    void invoke('ws_close', { id: this.id })
      .catch(() => undefined)
      .finally(() => this.teardown())
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
}
