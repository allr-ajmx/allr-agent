import type { ComposerTarget } from '@/app/chat/composer/focus'
import type { SessionView } from '@/app/chat/session-view'
import { takeSpeechChunk } from '@/lib/speech-chunker'
import { playSpeechTextUntilDone, stopVoicePlayback } from '@/lib/voice-playback'
import { $connection } from '@/store/connection'
import { notify, notifyError } from '@/store/notifications'
import {
  beginVoiceConversation,
  resetVoiceConversation,
  setConversationLevel,
  setConversationMuted,
  setConversationStatus
} from '@/store/voice-conversation'
import { lastReply, markReplySpoken } from '@/store/voice-reply-cursor'

import { voiceEngine } from './engine'
import { type VoiceErrorCopy, voiceErrorMessage } from './errors'
import type { VoiceArmMode, VoiceEvent, VoiceLease, VoiceTarget } from './types'

// The voice-conversation loop, as a module-level actor rather than a React effect.
// Every transition is driven by an AWAITED promise or a Rust `voice://` event —
// never by a re-render — which is the whole point of MJX-96: the "re-arm reachable
// only via a render" dead-end (patched in 55c8e23ce) becomes inexpressible.
//
// `$voiceConversation` is the render surface; `useVoiceConversation` just mirrors
// it. The controller owns all the private sequencing state (lease, turn sequence,
// in-flight playback) a nanostore can't hold.

/** Copy the controller needs; the i18n `notifications.voice` block satisfies it. */
export type ConversationCopy = VoiceErrorCopy & {
  unavailable: string
  configureSpeechToText: string
  couldNotStartSession: string
  playbackFailed: string
  noSpeechDetected: string
}

export interface ConversationBinding {
  /** The session whose replies are spoken (per-tile, not the global chat). */
  view: SessionView
  /** This composer's focus key, so its pill shows only on it. */
  target: ComposerTarget
  /** Submit a finalized transcript as a chat turn. */
  submit: (text: string) => Promise<void>
  /** False when speech-to-text isn't configured — surface the notice, don't start. */
  transcriptionAvailable: boolean
  copy: ConversationCopy
}

/** End the conversation after this many consecutive idle timeouts (~2 × 12 s). */
const MAX_IDLE_TIMEOUTS = 2

function currentTarget(): VoiceTarget | null {
  const conn = $connection.get()

  if (!conn) {
    return null
  }

  const headers: Record<string, string> = {}

  if (conn.token) {
    headers['X-Hermes-Session-Token'] = conn.token
  }

  return { baseUrl: conn.baseUrl, headers }
}

class ConversationController {
  private lease: VoiceLease | null = null
  private binding: ConversationBinding | null = null
  private offEvents: (() => void) | null = null
  private offConnection: (() => void) | null = null
  /** Bumped on every turn/end so a stale async continuation can detect it lost. */
  private turnSeq = 0
  private speaking = false
  private idleTimeouts = 0

  async start(binding: ConversationBinding): Promise<void> {
    if (this.lease) {
      return
    }

    if (!binding.transcriptionAvailable) {
      notify({
        kind: 'warning',
        title: binding.copy.unavailable,
        message: binding.copy.configureSpeechToText
      })
      resetVoiceConversation()

      return
    }

    const target = currentTarget()

    if (!target) {
      notifyError(new Error('not connected'), binding.copy.couldNotStartSession)
      resetVoiceConversation()

      return
    }

    this.binding = binding

    try {
      this.lease = await voiceEngine.open('conversation', { target })
    } catch (error) {
      notifyError(error, binding.copy.couldNotStartSession)
      resetVoiceConversation()
      this.binding = null

      return
    }

    this.idleTimeouts = 0
    beginVoiceConversation(binding.target)
    this.offEvents = this.lease.on(event => this.onEvent(event))
    // Keep the transcribe auth fresh across a token refresh / gateway switch.
    this.offConnection = $connection.subscribe(() => {
      const next = currentTarget()

      if (next) {
        void voiceEngine.updateAuth(next)
      }
    })

    await this.arm('normal')
  }

  async end(): Promise<void> {
    this.turnSeq += 1
    this.idleTimeouts = 0
    this.speaking = false

    this.offEvents?.()
    this.offEvents = null
    this.offConnection?.()
    this.offConnection = null

    stopVoicePlayback()

    const lease = this.lease
    this.lease = null
    this.binding = null

    if (lease) {
      await lease.close().catch(() => undefined)
    }

    resetVoiceConversation()
  }

  stopTurn(): void {
    // Space / on-screen "stop": end the current turn now. While recording this
    // finalizes; while armed-with-no-speech it yields turnEmpty → re-arm.
    void this.lease?.forceTurn()
  }

  toggleMute(): void {
    const muted = !this.mutedState
    this.mutedState = muted
    setConversationMuted(muted)

    if (muted) {
      void this.lease?.suspend()
    } else {
      void this.arm('normal')
    }
  }

  private mutedState = false

  private onEvent(event: VoiceEvent): void {
    switch (event.type) {
      case 'level':
        setConversationLevel(event.level)

        break

      case 'state':
        // Rust drives one status we don't derive ourselves: transcribing.
        if (event.state === 'finalizing') {
          setConversationStatus('transcribing')
        }

        break

      case 'speechStart':
        this.idleTimeouts = 0

        if (this.speaking) {
          // Barge-in: stop the assistant; the in-flight playback settles 'stopped'
          // and the barge turn's transcript will supersede the current one.
          stopVoicePlayback()
        }

        break

      case 'transcript':
        this.idleTimeouts = 0
        void this.runTurn(event.text)

        break

      case 'turnEmpty':
        void this.arm(this.armMode())

        break

      case 'idleTimeout':
        this.onIdleTimeout()

        break

      case 'error':
        this.onError(event.code, event.message)

        break
    }
  }

  private onIdleTimeout(): void {
    this.idleTimeouts += 1

    if (this.idleTimeouts >= MAX_IDLE_TIMEOUTS) {
      const copy = this.binding?.copy

      if (copy) {
        notify({ kind: 'info', title: copy.unavailable, message: copy.noSpeechDetected })
      }

      void this.end()
    }
  }

  private onError(code: string, message: string): void {
    const copy = this.binding?.copy

    if (copy) {
      notifyError(new Error(message || code), voiceErrorMessage(code, copy))
    }

    void this.end()
  }

  private async runTurn(text: string): Promise<void> {
    const binding = this.binding

    if (!binding) {
      return
    }

    const myTurn = ++this.turnSeq
    setConversationStatus('thinking')

    await binding.submit(text)

    if (myTurn !== this.turnSeq) {
      return
    }

    let armedForBargeIn = false

    for await (const chunk of this.replyChunks(binding.view, myTurn)) {
      if (myTurn !== this.turnSeq) {
        return
      }

      // Arm barge-in only once we actually start speaking, so a user speaking
      // during 'thinking' doesn't get captured against an empty reply.
      if (!armedForBargeIn) {
        await this.arm('bargein')
        armedForBargeIn = true
      }

      setConversationStatus('speaking')
      this.speaking = true
      const outcome = await playSpeechTextUntilDone(chunk, { source: 'voice-conversation' })
      this.speaking = false

      if (myTurn !== this.turnSeq) {
        return
      }

      if (outcome === 'stopped') {
        // Interrupted (barge-in / end): the interrupting turn drives what's next.
        return
      }
    }

    await this.arm(this.armMode())
  }

  /**
   * Yield speakable chunks as the reply for `myTurn` grows, ending when the reply
   * completes. Mirrors the old driving effect's chunking, but sequenced by awaited
   * store updates instead of re-renders.
   */
  private async *replyChunks(view: SessionView, myTurn: number): AsyncGenerator<string> {
    let buffer = ''
    let sourceLength = 0
    let responseId: string | null = null

    while (myTurn === this.turnSeq) {
      const reply = lastReply(view)
      const busy = view.$busy.get()

      if (reply) {
        if (reply.id !== responseId) {
          buffer = ''
          sourceLength = 0
          responseId = reply.id
        }

        if (reply.text.length > sourceLength) {
          buffer += reply.text.slice(sourceLength)
          sourceLength = reply.text.length
        }

        const complete = !reply.pending && !busy
        const { chunk, rest } = takeSpeechChunk(buffer, complete)
        buffer = rest

        if (chunk) {
          yield chunk

          continue
        }

        if (complete) {
          markReplySpoken(view)

          return
        }
      } else if (!busy) {
        // No unspoken reply and the turn isn't running → nothing to speak.
        return
      }

      await this.waitForReplyUpdate(view)
    }
  }

  /** Resolve on the next `$messages`/`$busy` change, with a periodic re-check so a
   * missed edge can never hang the loop. */
  private waitForReplyUpdate(view: SessionView): Promise<void> {
    return new Promise(resolve => {
      let settled = false

      const done = () => {
        if (settled) {
          return
        }

        settled = true
        offMessages()
        offBusy()
        window.clearTimeout(timer)
        resolve()
      }

      const offMessages = view.$messages.listen(done)
      const offBusy = view.$busy.listen(done)
      const timer = window.setTimeout(done, 300)
    })
  }

  private armMode(): VoiceArmMode {
    // Barge-in is the standing policy; it only bites during TTS, and re-arming
    // 'bargein' between turns is harmless (higher threshold, no playback to stop).
    return 'normal'
  }

  private async arm(mode: VoiceArmMode): Promise<void> {
    if (!this.lease || this.mutedState) {
      return
    }

    if (mode === 'normal') {
      setConversationStatus('listening')
    }

    try {
      await this.lease.arm(mode)
    } catch {
      // A failed arm surfaces via a subsequent error event; don't crash the loop.
    }
  }
}

export const voiceConversation = new ConversationController()
