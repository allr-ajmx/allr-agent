import { invoke } from '@tauri-apps/api/core'

import { IS_TAURI } from '@/lib/platform'

import { VoiceBusyError } from './errors'
import { createNativeLease, type EngineLease } from './native-engine'
import type { VoiceEngine, VoiceLease, VoiceOpenOptions, VoiceOwner, VoiceTarget } from './types'
import { createWebLease } from './web-engine'

// The single voice-mic owner for the whole app. Both consumers — the conversation
// loop and push-to-talk dictation — lease from here rather than each owning a
// recorder, which is what removes the "four recorder instances share one device"
// race. Rust's `already_open` is the backstop; this lease adds a synchronous,
// typed contention failure and a priority policy on top.
//
// Priority: a live conversation is a long-running mode and beats the momentary
// dictation button (dictation gets `VoiceBusyError`); a conversation starting
// while dictation is recording preempts it. Encoded once here rather than as
// ad-hoc try/catch at each call site.

class VoiceEngineImpl implements VoiceEngine {
  private _owner: VoiceOwner | null = null
  private lease: EngineLease | null = null
  private nativeActive = false
  /** One-shot: once the native engine fails to open, use the web engine for the
   * rest of the process rather than retrying native every turn. */
  private downgraded = false

  get owner(): VoiceOwner | null {
    return this._owner
  }

  async open(owner: VoiceOwner, opts: VoiceOpenOptions): Promise<VoiceLease> {
    if (this._owner) {
      if (this._owner === 'conversation' && owner === 'dictation') {
        throw new VoiceBusyError('conversation')
      }

      // Same owner re-opening, or a conversation preempting dictation: release first.
      await this.release()
    }

    const { lease, native } = await this.createAndInit(opts)
    this._owner = owner
    this.lease = lease
    this.nativeActive = native

    // If the session closes on its own (device_lost, natural close), drop ownership
    // so the next open() isn't blocked by a dead lease.
    lease.on(event => {
      if (event.type === 'state' && event.state === 'closed') {
        this.clear(lease)
      }
    })

    return this.wrap(lease)
  }

  private async createAndInit(opts: VoiceOpenOptions): Promise<{ lease: EngineLease; native: boolean }> {
    if (IS_TAURI && !this.downgraded) {
      const lease = createNativeLease()

      try {
        await lease.init(opts)

        return { lease, native: true }
      } catch (error) {
        this.downgraded = true
        console.warn('native voice engine failed to open; downgrading to web', error)
      }
    }

    const web = createWebLease()
    await web.init(opts)

    return { lease: web, native: false }
  }

  async updateAuth(target: VoiceTarget): Promise<void> {
    // Only the native session holds auth in Rust; the web engine transcribes via
    // the JS $connection path, which refreshes itself.
    if (this._owner && this.nativeActive) {
      await invoke('voice_update_auth', { target }).catch(() => undefined)
    }
  }

  private async release(): Promise<void> {
    const lease = this.lease

    if (lease) {
      await lease.close().catch(() => undefined)
      this.clear(lease)
    }
  }

  private clear(lease: EngineLease): void {
    if (this.lease === lease) {
      this.lease = null
      this._owner = null
      this.nativeActive = false
    }
  }

  private wrap(lease: EngineLease): VoiceLease {
    const engine = this

    return {
      arm: mode => lease.arm(mode),
      suspend: () => lease.suspend(),
      forceTurn: () => lease.forceTurn(),
      on: handler => lease.on(handler),
      get closed() {
        return lease.closed
      },
      async close() {
        await lease.close()
        engine.clear(lease)
      }
    }
  }
}

export const voiceEngine: VoiceEngine = new VoiceEngineImpl()
