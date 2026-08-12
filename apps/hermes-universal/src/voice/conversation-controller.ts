import type { ComposerTarget } from '@/app/chat/composer/focus'
import type { SessionView } from '@/app/chat/session-view'
import { takeSpeechChunk } from '@/lib/speech-chunker'
import { playSpeechTextUntilDone, stopVoicePlayback } from '@/lib/voice-playback'
import { isVoiceStopCommand } from '@/lib/voice-stop-word'
import { $connection } from '@/store/connection'
import { notify, notifyError } from '@/store/notifications'
import {
  beginVoiceConversation,
  resetVoiceConversation,
  setConversationLevel,
  setConversationMuted,
  setConversationStatus
} from '@/store/voice-conversation'
import { markReplySpoken, unspokenTurn } from '@/store/voice-reply-cursor'
import { pauseWakeForVoice, resumeWakeAfterVoice } from '@/store/wake-word'

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
  sayStopToEnd: string
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

    // Let the wake listener release the device BEFORE we ask for it. The engine's
    // priority policy already preempts our own wake lease, but on a `capture:
    // "local"` backend the microphone is held by the gateway host, and only
    // `wake.pause` frees that one.
    await pauseWakeForVoice()

    try {
      this.lease = await voiceEngine.open('conversation', { target })
    } catch (error) {
      notifyError(error, binding.copy.couldNotStartSession)
      resetVoiceConversation()
      this.binding = null
      // We took the ear off the air for a conversation that never started.
      void resumeWakeAfterVoice()

      return
    }

    this.idleTimeouts = 0
    // Consume whatever reply already sits at the bottom of this session before
    // the first turn. Without it the cursor is unset, and the turn selector
    // (which aggregates EVERYTHING after the cursor) would narrate the entire
    // prior transcript the moment the first reply lands.
    markReplySpoken(binding.view)
    beginVoiceConversation(binding.target)
    // Hands-free means hands-free: tell the user the way out is spoken, once,
    // when the loop opens. Fixed id so re-entering doesn't stack notices.
    notify({ id: 'voice-stop-hint', kind: 'info', icon: 'mic', message: binding.copy.sayStopToEnd })
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
    // Re-arm the ear once the device is genuinely free (after the lease closed,
    // not before — the detector would lose the race for the mic).
    await resumeWakeAfterVoice()
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

        // "stop" / "never mind" / "goodbye" ENDS the hands-free conversation
        // instead of being submitted as a turn — the only way out when your hands
        // are busy. Whole-utterance matching only, so "stop the container" is
        // still a real request (lib/voice-stop-word.ts).
        if (isVoiceStopCommand(event.text)) {
          void this.end()

          break
        }

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

      if (outcome === 'error') {
        // Synthesis is broken (no provider configured, backend down). Say so and
        // stop narrating this turn — hands-free means the user may not be looking
        // at the screen, and silently re-arming the mic after every failed clip is
        // a live microphone and a lit "listening" pill attached to nothing. `break`
        // rather than `return`: the re-arm below still has to run.
        notifyError(new Error('speech synthesis failed'), binding.copy.playbackFailed)
        // Consume the reply anyway: `replyChunks` only advances the cursor when it
        // runs to completion, and leaving it unspoken makes the NEXT turn open by
        // re-narrating this one from the top.
        markReplySpoken(binding.view)

        break
      }
    }

    await this.arm(this.armMode())
  }

  /**
   * Yield speakable chunks as the reply for `myTurn` grows, ending when the reply
   * completes. Mirrors the old driving effect's chunking, but sequenced by awaited
   * store updates instead of re-renders.
   *
   * The source is the whole unspoken TURN (`unspokenTurn`), not the newest
   * bubble: a turn that calls tools narrates itself across several bubbles, and
   * binding to one bubble spoke only a fragment of it. The aggregate is
   * append-only and its `id` is stable for the turn, so the `slice(sourceLength)`
   * delta feed below still holds.
   */
  private async *replyChunks(view: SessionView, myTurn: number): AsyncGenerator<string> {
    let buffer = ''
    let sourceLength = 0
    let responseId: string | null = null

    while (myTurn === this.turnSeq) {
      const reply = unspokenTurn(view)
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
