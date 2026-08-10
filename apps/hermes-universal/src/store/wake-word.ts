import {
  feedWakeAudio,
  isMissingRpcMethod,
  pauseWakeWord,
  resumeWakeWord,
  startWakeWord,
  stopWakeWord,
  type WakeCapture,
  type WakeStatusResult,
  wakeWordStatus
} from '@/lib/gateway-rpc'
import { playWakeSound } from '@/lib/wake-sound'
import { atom } from '@/store/atom'
import { addGatewayEventListener } from '@/store/gateway'
import { voiceEngine } from '@/voice/engine'
import type { VoiceLease } from '@/voice/types'

/**
 * "Hey Hermes" — the hands-free wake word.
 *
 * The detector is NOT ours. openWakeWord/sherpa run on the gateway
 * (`tools/wake_word.py`), which owns the phrase, the model and the profile
 * routing; this module only arms it, keeps the toggle in step, and — when the
 * gateway answers `capture: "client"` because its host has no microphone —
 * supplies the audio.
 *
 * Two rules, both upstream's:
 *
 *  * **The toggle IS the config.** There is no separate client preference:
 *    `wake_word.enabled` in the gateway config is the only state, and only a
 *    deliberate click (`persist: true`) writes it. Every passive re-arm — app
 *    start, the end of a voice conversation — must leave it alone, or a mic
 *    becomes permanently enabled because a window opened.
 *  * **A detection starts a conversation, it does not transcribe.** The wake
 *    phrase itself is never sent anywhere: `wake.detected` frees the mic, plays
 *    the chime, and asks the composer to open a real voice turn.
 */

export interface WakeWordState {
  /** The backend can run a detector at all (model present, deps installed). */
  available: boolean
  /** `wake_word.enabled` as the backend reports it — the toggle's truth. */
  enabled: boolean
  /** A detector is armed right now (by us or by another surface). */
  listening: boolean
  /** Armed by THIS client, so our stop/pause calls will be honoured. */
  owned: boolean
  /** Where the mic is. `client` means we are streaming frames up. */
  capture: WakeCapture
  /** The phrase to show ("hey hermes"), never used for matching here. */
  phrase: string
  /** Why the last attempt refused, for the tooltip. */
  reason: null | string
  hint: null | string
  /** Paused because a voice conversation holds the mic. */
  pausedForVoice: boolean
  /** We are actively pushing PCM at `wake.feed`. */
  streaming: boolean
  /** A start/stop round trip is in flight — the toggle shows it and refuses re-entry. */
  busy: boolean
}

const INITIAL: WakeWordState = {
  available: false,
  enabled: false,
  listening: false,
  owned: false,
  capture: 'local',
  phrase: 'hey hermes',
  reason: null,
  hint: null,
  pausedForVoice: false,
  streaming: false,
  busy: false
}

export const $wakeWord = atom<WakeWordState>(INITIAL)

function patch(next: Partial<WakeWordState>): void {
  $wakeWord.set({ ...$wakeWord.get(), ...next })
}

function applyStatus(status: WakeStatusResult): void {
  patch({
    available: Boolean(status.available),
    enabled: Boolean(status.enabled),
    listening: Boolean(status.listening),
    owned: Boolean(status.owned_by_caller),
    capture: status.capture === 'client' ? 'client' : 'local',
    phrase: status.phrase || $wakeWord.get().phrase,
    hint: status.hint ?? null
  })
}

// --- client capture --------------------------------------------------------

/** The mic lease held while we stream wake audio, or null when the backend's own
 *  microphone is doing the listening. */
let captureLease: VoiceLease | null = null
let captureOff: (() => void) | null = null

/**
 * Open the mic and stream 16 kHz int16 batches at `wake.feed`.
 *
 * The capture is Rust's (`voice_wake_listen`), not `getUserMedia`'s: on Tauri the
 * native engine is the only path that reaches the device on every target, and it
 * already owns the resample-to-16 kHz pipeline. The web fallback engine rejects
 * `wakeListen`, which lands here as a refusal the toggle can explain instead of a
 * detector nobody feeds.
 */
async function startClientCapture(): Promise<boolean> {
  if (captureLease) {
    return true
  }

  try {
    const lease = await voiceEngine.open('wake', { target: { baseUrl: '', headers: {} } })

    captureOff = lease.on(event => {
      if (event.type === 'wakeFrame' && event.pcm) {
        // Fire and forget: a dropped frame is a millisecond of missed audio, and
        // awaiting here would let a slow socket stall the emitter behind it.
        void feedWakeAudio(event.pcm).catch(() => undefined)
      }
    })

    await lease.wakeListen()
    captureLease = lease
    patch({ streaming: true })

    return true
  } catch (error) {
    await stopClientCapture()
    patch({
      streaming: false,
      reason: 'capture_failed',
      hint: error instanceof Error ? error.message : String(error)
    })

    return false
  }
}

async function stopClientCapture(): Promise<void> {
  const lease = captureLease
  captureOff?.()
  captureOff = null
  captureLease = null

  if (lease) {
    await lease.close().catch(() => undefined)
  }

  patch({ streaming: false })
}

// --- arm / disarm ----------------------------------------------------------

async function applyStart(persist: boolean): Promise<void> {
  const answer = await startWakeWord({ persist })

  if (!answer.started) {
    await stopClientCapture()
    patch({
      listening: false,
      owned: false,
      streaming: false,
      reason: answer.reason ?? 'refused',
      hint: answer.hint ?? null,
      // `unavailable` is the only refusal that says the backend CAN'T; the rest
      // ("disabled", "owned by another surface") leave the capability intact.
      available: answer.reason !== 'unavailable',
      ...(persist ? {} : {})
    })

    return
  }

  const capture: WakeCapture = answer.capture === 'client' ? 'client' : 'local'
  patch({
    listening: true,
    owned: true,
    available: true,
    capture,
    enabled: persist ? true : $wakeWord.get().enabled,
    phrase: answer.phrase || $wakeWord.get().phrase,
    reason: null,
    hint: null,
    pausedForVoice: false
  })

  if (capture === 'client') {
    await startClientCapture()
  } else {
    // The gateway host is holding its own microphone; ours must not also be open.
    await stopClientCapture()
  }
}

/**
 * Reconcile with the backend without changing the user's preference: read
 * `wake.status`, and arm only when the config already says enabled. This is the
 * app-start and post-conversation path.
 */
export async function armWakeWord(): Promise<void> {
  try {
    const status = await wakeWordStatus()
    applyStatus(status)

    if (!status.enabled || !status.available) {
      return
    }

    if (status.listening && status.owned_by_caller) {
      // Already ours. Client capture can still be missing after a resume raced
      // the mic release, so re-assert it.
      if (status.capture === 'client') {
        await startClientCapture()
      }

      return
    }

    await applyStart(false)
  } catch (error) {
    if (isMissingRpcMethod(error)) {
      patch({ available: false, reason: 'unsupported_backend' })

      return
    }

    patch({ reason: 'status_failed', hint: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * The composer's ear button. This is the ONLY path that writes
 * `wake_word.enabled`, in both directions.
 */
export async function toggleWakeWord(): Promise<void> {
  if ($wakeWord.get().busy) {
    return
  }

  patch({ busy: true })

  try {
    if ($wakeWord.get().enabled) {
      await stopClientCapture()
      const answer = await stopWakeWord({ persist: true })
      patch({
        listening: false,
        owned: false,
        pausedForVoice: false,
        enabled: answer.disabled_persisted === false ? $wakeWord.get().enabled : false,
        reason: answer.stopped ? null : (answer.reason ?? null)
      })

      return
    }

    await applyStart(true)
  } catch (error) {
    patch({
      reason: isMissingRpcMethod(error) ? 'unsupported_backend' : 'toggle_failed',
      hint: error instanceof Error ? error.message : String(error)
    })
  } finally {
    patch({ busy: false })
  }
}

// --- voice-conversation handover -------------------------------------------

/**
 * Release the device before a voice conversation opens its own mic.
 *
 * Resolves only once the detector has actually let go — the conversation awaits
 * this. Opening capture while the wake listener still holds the device is the
 * "clicked voice, nothing happened" bug, and on a client-capture backend BOTH
 * ends have to release: the local lease here and the detector there.
 */
export async function pauseWakeForVoice(): Promise<void> {
  if (!$wakeWord.get().listening && !captureLease) {
    return
  }

  patch({ pausedForVoice: true })
  await stopClientCapture()

  try {
    await pauseWakeWord()
  } catch {
    // No detector / older backend — nothing was holding the mic.
  }
}

/**
 * Re-arm after a conversation ends. RECONCILE, don't just resume: the wake word
 * is a persistent setting, so a raw `wake.resume` that loses the mic-release race
 * would leave the ear off until the next restart. `armWakeWord` re-reads the
 * truth and starts from scratch when the resume didn't take.
 */
export async function resumeWakeAfterVoice(): Promise<void> {
  if (!$wakeWord.get().pausedForVoice) {
    return
  }

  patch({ pausedForVoice: false })

  try {
    const answer = await resumeWakeWord()

    if (answer.resumed) {
      const status = await wakeWordStatus()
      applyStatus(status)

      if (status.capture === 'client' && status.owned_by_caller) {
        await startClientCapture()
      }

      return
    }
  } catch {
    // fall through to the full reconcile
  }

  await armWakeWord()
}

// --- detection --------------------------------------------------------------

type StartConversation = (profile: null | string) => void

let onDetected: StartConversation | null = null

/** Register what a detection should open. The composer owns that decision, so it
 *  hands its starter in rather than this module reaching into the chat. */
export function setWakeConversationStarter(starter: null | StartConversation): void {
  onDetected = starter
}

/**
 * `wake.detected` — the phrase fired.
 *
 * Order matters: free the mic FIRST so the conversation's own capture can open
 * the device, then chime, then start. The phrase audio itself is dropped by the
 * Rust machine when it arms, so the agent is never asked "hey hermes".
 */
addGatewayEventListener(event => {
  if (event.type !== 'wake.detected') {
    return
  }

  const payload = (event.payload ?? {}) as { phrase?: string; profile?: null | string }
  const profile = payload.profile || null

  patch({ phrase: payload.phrase || $wakeWord.get().phrase })

  void (async () => {
    await stopClientCapture()
    playWakeSound()
    onDetected?.(profile)
  })()
})
