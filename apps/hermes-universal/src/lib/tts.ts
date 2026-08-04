import { speakText } from '@/hermes'
import { atom } from '@/store/atom'

// Text-to-speech playback. speakText returns a data-URL the webview can play
// directly via an <audio> element — no AudioContext needed. One clip plays at a
// time; a new speak (or stopSpeaking) interrupts the previous.
export const $ttsSpeaking = atom(false)

/** How a `speakUntilDone` playback ended. */
export type SpeechEnd = 'ended' | 'stopped' | 'error' | 'skipped'

let current: HTMLAudioElement | null = null
// The resolver for the in-flight `speakUntilDone`, settled exactly once when the
// clip ends, errors, or is interrupted by stopSpeaking / a new clip. Kept beside
// `current` so an interruption never leaves a caller awaiting forever — which is
// exactly the "loop goes deaf" failure mode barge-in would otherwise reintroduce.
let pendingEnd: ((result: SpeechEnd) => void) | null = null

function settleEnd(result: SpeechEnd): void {
  const resolve = pendingEnd
  pendingEnd = null
  resolve?.(result)
}

export function stopSpeaking(): void {
  if (current) {
    current.pause()
    current.src = ''
    current = null
  }

  $ttsSpeaking.set(false)
  settleEnd('stopped')
}

/**
 * Begin playback and return a promise that resolves the moment the clip *starts*
 * (or bails on empty/error), alongside a `done` promise that resolves when it
 * *finishes*. Splitting the two is the whole point: callers that must wait for the
 * clip to end (the voice-conversation loop) await `done`; callers that only need
 * playback to have begun (`speakNow`) drop it.
 */
async function startPlayback(text: string): Promise<{ done: Promise<SpeechEnd> }> {
  const trimmed = text.trim()

  if (!trimmed || typeof Audio === 'undefined') {
    return { done: Promise.resolve('skipped') }
  }

  stopSpeaking()

  try {
    const res = await speakText(trimmed)

    if (!res.ok || !res.data_url) {
      return { done: Promise.resolve('skipped') }
    }

    const audio = new Audio(res.data_url)
    current = audio
    $ttsSpeaking.set(true)

    const done = new Promise<SpeechEnd>(resolve => {
      pendingEnd = resolve
    })

    const finish = (result: SpeechEnd) => {
      if (current === audio) {
        current = null
        $ttsSpeaking.set(false)
      }

      settleEnd(result)
    }

    audio.onended = () => finish('ended')
    audio.onerror = () => finish('error')
    await audio.play().catch(() => finish('error'))

    return { done }
  } catch {
    stopSpeaking()

    return { done: Promise.resolve('error') }
  }
}

/** Resolves once playback has begun (or bailed). Unchanged timing — three other
 * consumers (read-aloud, auto-speak, the store's message.complete) depend on it. */
export async function speakNow(text: string): Promise<void> {
  await startPlayback(text)
}

/** Resolves when the clip finishes, is interrupted (`stopSpeaking` / a newer
 * clip), errors, or never started. Never rejects. */
export async function speakUntilDone(text: string): Promise<SpeechEnd> {
  const { done } = await startPlayback(text)

  return done
}
