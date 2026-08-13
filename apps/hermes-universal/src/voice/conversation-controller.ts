import type { ComposerTarget } from '@/app/chat/composer/focus'
import type { SessionView } from '@/app/chat/session-view'
import { takeSpeechChunk } from '@/lib/speech-chunker'
import { syncThinkingSound } from '@/lib/thinking-sound'
import { markVoicePlaybackInterrupted, playSpeechTextUntilDone, stopVoicePlayback } from '@/lib/voice-playback'
import { isVoiceStopCommand } from '@/lib/voice-stop-word'
import { $connection } from '@/store/connection'
import { notify, notifyError } from '@/store/notifications'
import {
  $voiceConversation,
  beginVoiceConversation,
  resetVoiceConversation,
  setConversationLevel,
  setConversationMuted,
  setConversationStatus
} from '@/store/voice-conversation'
import { conversationVoiceVad } from '@/store/voice-prefs'
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
  /**
   * Stop the turn this session is running — the Stop button's own seam.
   *
   * The generation half of full-duplex barge-in needs it (MJXHRM-228): speaking
   * over a reply that is still being GENERATED has to stop the model, or the
   * interrupting utterance queues behind a turn nobody wants any more — and
   * `submit` refuses outright while the session is busy, so it would not even
   * queue, it would vanish. Supplied by the surface rather than reached for
   * here: the controller has no static edge to the chat store and must not grow
   * one (`store/chat` → `lib/voice-playback` → back here is a cycle).
   */
  interrupt: () => Promise<void>
  /** False when speech-to-text isn't configured — surface the notice, don't start. */
  transcriptionAvailable: boolean
  copy: ConversationCopy
}

/** End the conversation after this many consecutive idle timeouts (~2 × 12 s). */
const MAX_IDLE_TIMEOUTS = 2

/**
 * How long a generation-phase barge waits for its interrupt to actually stop the
 * turn before submitting anyway.
 *
 * `session.interrupt` returns BEFORE the provider stops (see `interruptSession`
 * in `store/chat.ts`), and the submit path refuses while the session is busy —
 * so without this wait the interrupting utterance is dropped silently, which is
 * the failure that looks exactly like "it didn't hear me". Desktop waits the
 * same 5 s (`use-voice-conversation.ts`, `INTERRUPT_SETTLE_TIMEOUT_MS`).
 */
const INTERRUPT_SETTLE_MS = 5_000

/** How often the settle wait re-reads `$busy`. */
const INTERRUPT_POLL_MS = 100

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
  /**
   * The turn whose reply is still being produced, or 0.
   *
   * A turn id rather than a boolean, so it self-invalidates: every path that
   * supersedes a turn bumps `turnSeq` already — a new transcript, `end()` — and
   * a flag left set by an abandoned continuation would have the next barge
   * interrupt a session that is not running anything.
   */
  private generatingTurn = 0
  /** Whether any of the current turn's reply has been spoken yet. Decides
   *  whether a barge may claim a SPOKEN reply was cut off — see `onBargeIn`. */
  private spokenAnything = false

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
      // Read at OPEN, not at module load: the levels are seeded asynchronously
      // from config and can be dragged between conversations, and Rust takes the
      // VAD once per session — so this is the moment the user's calibration has
      // to be picked up (MJXHRM-90).
      this.lease = await voiceEngine.open('conversation', { target, vad: conversationVoiceVad() })
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
    this.generatingTurn = 0
    this.spokenAnything = false

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
        this.onBargeIn()

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

  /** The current turn is still being produced (and has not been superseded). */
  private get generating(): boolean {
    return this.generatingTurn !== 0 && this.generatingTurn === this.turnSeq
  }

  /**
   * The user spoke while the agent had the floor — full-duplex barge-in
   * (MJXHRM-228).
   *
   * TWO windows, and until now only the second was covered. The mic was armed
   * for the first time at the first spoken chunk, so between submitting a turn
   * and hearing it start to speak the session sat `Idle`, where the Rust machine
   * DISCARDS audio (`machine.rs`, `on_frames`) — the app was deaf for exactly
   * the stretch a user is most likely to say "no, wait". That is the half-duplex
   * gap desktop closed in `e0233f8fc5`; the fix here is the same shape, in the
   * state machine instead of a JS analyser (`runTurn` arms straight after the
   * submit).
   *
   *  * **Generation** — nothing is playing; there is a model producing tokens.
   *    Stop it. Without that the barge utterance is transcribed and then dropped
   *    on the floor: `submit` refuses while the session is busy.
   *  * **Playback** — cut the audio. The in-flight clip settles `stopped` and the
   *    barge turn's transcript supersedes this one.
   *
   * `markVoicePlaybackInterrupted` is deliberately NOT called for a barge that
   * lands before a word has been spoken, and this is where universal diverges
   * from desktop on purpose (desktop's `onSpeech` marks unconditionally). The
   * flag makes the gateway prepend a fixed note to the next turn — "the user
   * interrupted your previous SPOKEN reply before it finished"
   * (`tools/tts_streaming.py`) — so sending it for a turn that never reached the
   * speakers tells the model something that did not happen. `spokenAnything`,
   * not `speaking`, because a barge landing in the gap between two clips of one
   * reply did cut that reply off mid-narration.
   *
   * The interrupt is conditioned on the session actually being busy. Interrupting
   * an idle agent can leave a stale interrupt flag that cancels the NEXT turn
   * (`store/chat.ts`, `runRewindSubmit`), and the turn can complete between the
   * last chunk being handed to the speakers and the user talking over it.
   */
  private onBargeIn(): void {
    const binding = this.binding

    if (!binding || (!this.speaking && !this.generating)) {
      return
    }

    if (this.speaking || this.spokenAnything) {
      // Latch it FIRST. `stopVoicePlayback` clears `$voicePlayback`, so by the
      // time the barge utterance has been transcribed and reaches `sendPrompt`
      // there is no longer any live playback for that path to notice — this is
      // the only site that still knows a reply was cut off mid-sentence.
      markVoicePlaybackInterrupted()
    }

    if (this.speaking) {
      stopVoicePlayback()
    }

    if (this.generating && binding.view.$busy.get()) {
      void binding.interrupt().catch(() => undefined)
    }
  }

  /**
   * Wait for a just-interrupted turn to actually settle, bounded.
   *
   * Runs before every submit and costs nothing on the normal path, where the
   * session is not busy. If the wait expires the submit goes ahead and the
   * binding's own busy guard drops it — the loop still re-arms (an empty reply
   * ends `replyChunks` through its "no reply and not busy" branch), so a
   * gateway that never stops leaves the user repeating themselves rather than
   * facing a dead microphone.
   */
  private async settleInterrupt(view: SessionView, myTurn: number): Promise<void> {
    const deadline = Date.now() + INTERRUPT_SETTLE_MS

    while (view.$busy.get() && myTurn === this.turnSeq && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, INTERRUPT_POLL_MS))
    }
  }

  private onIdleTimeout(): void {
    // The mic is armed through the generation and playback windows now, so the
    // VAD's idle timer runs while the AGENT is the one taking time. A user
    // waiting out a two-minute turn is not an idle conversation, and counting
    // those would end it under them — the timeout only means "nobody is here"
    // when it is the user's turn to speak.
    if (this.generating || this.speaking) {
      this.idleTimeouts = 0

      return
    }

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
    this.generatingTurn = 0
    this.spokenAnything = false
    setConversationStatus('thinking')

    // This transcript may BE a barge that just interrupted the previous turn.
    // The interrupt returns before the provider stops, and the submit refuses
    // while the session is busy, so wait for it to land first.
    await this.settleInterrupt(binding.view, myTurn)

    if (myTurn !== this.turnSeq) {
      return
    }

    await binding.submit(text)

    if (myTurn !== this.turnSeq) {
      return
    }

    // Live through GENERATION, not just playback. Armed after the submit
    // resolves rather than before it: a barge that lands while `prompt.submit`
    // is still in the air has no turn to interrupt, and interrupting a session
    // that is not yet running one is the stale-flag hazard `onBargeIn` guards
    // against.
    //
    // 'normal' thresholds here, and that is not an oversight — barge-in's higher
    // onset exists to stop the assistant's own speakers tripping the mic, and
    // during generation nothing is playing. It matches desktop's phase-aware
    // trigger, which clamps up only while audio is flowing. Announcing
    // 'listening' is suppressed: the agent is thinking, the pill and the ambient
    // blips both follow that status, and a mic being live is not a prompt to
    // speak.
    this.generatingTurn = myTurn
    await this.arm('normal', { announce: false })

    let armedForBargeIn = false

    for await (const chunk of this.replyChunks(binding.view, myTurn)) {
      if (myTurn !== this.turnSeq) {
        return
      }

      // Switch to barge-in thresholds as the speakers open. The session is
      // already Armed, so this only re-tunes the VAD (`machine.rs`, `on_arm`) —
      // no state transition, no gap in which the mic is deaf.
      if (!armedForBargeIn) {
        await this.arm('bargein')
        armedForBargeIn = true
      }

      setConversationStatus('speaking')
      this.speaking = true
      this.spokenAnything = true
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

    // The turn is over: nothing left to interrupt, so a later barge must not try
    // to. Only if this turn still owns the loop — a superseded one returns above
    // and its successor is already the generating turn.
    if (myTurn === this.turnSeq) {
      this.generatingTurn = 0
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

  /**
   * Arm the mic.
   *
   * `announce` defaults to what the mode implies — arming 'normal' is normally
   * the loop handing the floor back — and is passed explicitly by the one caller
   * that arms the SAME mode for the opposite reason: the generation window,
   * where the mic goes live while the agent is still the one talking.
   */
  private async arm(mode: VoiceArmMode, { announce = mode === 'normal' }: { announce?: boolean } = {}): Promise<void> {
    if (!this.lease || this.mutedState) {
      return
    }

    if (announce) {
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

// The ambient "thinking" blips follow the conversation's own render surface
// rather than being started and stopped at each transition inside the controller.
// Every status the loop can reach passes through `$voiceConversation`, including
// the ones that end it (`resetVoiceConversation`), so there is no exit — error,
// stop word, idle timeout, disconnect — that can leave the blips running. Bound
// here, at the controller, because this module is what a surface imports to
// drive a conversation at all.
$voiceConversation.subscribe(syncThinkingSound)
