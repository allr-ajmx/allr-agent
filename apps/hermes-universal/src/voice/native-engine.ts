import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  VoiceArmMode,
  VoiceEmptyReason,
  VoiceEvent,
  VoiceEventHandler,
  VoiceLease,
  VoiceOpenOptions,
  VoiceStateKind
} from './types'

// The Rust-backed session (src-tauri/src/voice). A thin IPC client: it subscribes
// to all seven `voice://{id}/…` topics BEFORE invoking `voice_open` (the
// pty:///ws:// convention — no early event dropped) and forwards decoded
// `VoiceEvent`s. The arm/suspend/force/close/update-auth commands are global (Rust
// holds a single session), so only `voice_open` carries the id.

/** A lease with the extra `init` the engine calls after construction. */
export interface EngineLease extends VoiceLease {
  init(opts: VoiceOpenOptions): Promise<void>
}

export function createNativeLease(): EngineLease {
  return new NativeVoiceLease()
}

type AnyRecord = Record<string, any>

class NativeVoiceLease implements EngineLease {
  private readonly id = crypto.randomUUID()
  private unlisten: UnlistenFn[] = []
  private readonly handlers = new Set<VoiceEventHandler>()
  private _closed = false
  private closeRequested = false

  async init(opts: VoiceOpenOptions): Promise<void> {
    const sub = (suffix: string, map: (payload: unknown) => VoiceEvent) =>
      listen(`voice://${this.id}/${suffix}`, event => this.dispatch(map(event.payload)))

    this.unlisten = await Promise.all([
      sub('state', payload => ({ type: 'state', state: payload as VoiceStateKind })),
      sub('level', payload => ({ type: 'level', level: typeof payload === 'number' ? payload : 0 })),
      sub('speechStart', () => ({ type: 'speechStart' })),
      sub('transcript', payload => {
        const o = (payload ?? {}) as AnyRecord

        return {
          type: 'transcript',
          text: String(o.text ?? ''),
          provider: o.provider ?? null,
          durationMs: Number(o.durationMs ?? 0)
        }
      }),
      sub('turnEmpty', payload => ({
        type: 'turnEmpty',
        reason: ((payload ?? {}) as AnyRecord).reason as VoiceEmptyReason
      })),
      sub('idleTimeout', () => ({ type: 'idleTimeout' })),
      sub('error', payload => {
        const o = (payload ?? {}) as AnyRecord

        return { type: 'error', code: String(o.code ?? 'unknown'), message: String(o.message ?? '') }
      })
    ])

    // A close() that landed while we were subscribing: don't open a device we are
    // about to abandon (the close-during-init race the transport classes guard).
    if (this.closeRequested) {
      await invoke('voice_close').catch(() => undefined)
      this._closed = true
      this.teardown()

      return
    }

    await invoke('voice_open', {
      id: this.id,
      target: opts.target,
      vad: opts.vad,
      format: opts.format
    })
  }

  private dispatch(event: VoiceEvent): void {
    if (event.type === 'state' && event.state === 'closed') {
      this._closed = true
    }

    for (const handler of this.handlers) {
      handler(event)
    }
  }

  on(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler)

    return () => this.handlers.delete(handler)
  }

  get closed(): boolean {
    return this._closed
  }

  async arm(mode: VoiceArmMode = 'normal'): Promise<void> {
    await invoke('voice_arm', { mode })
  }

  async suspend(): Promise<void> {
    await invoke('voice_suspend')
  }

  async forceTurn(): Promise<void> {
    await invoke('voice_force_turn')
  }

  async close(): Promise<void> {
    this.closeRequested = true

    if (this._closed) {
      this.teardown()

      return
    }

    this._closed = true
    await invoke('voice_close').catch(() => undefined)
    this.teardown()
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
    this.handlers.clear()
  }
}
