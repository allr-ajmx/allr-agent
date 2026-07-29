import { speakNow, speakUntilDone, type SpeechEnd, stopSpeaking } from '@/lib/tts'
import { $voicePlayback, resetVoicePlayback, type VoicePlaybackSource } from '@/store/voice-playback'

// Read-aloud driver. Mirrors desktop's `@/lib/voice-playback` contract closely
// enough that the ported action-bar `ReadAloudItem` runs unchanged, but plays
// through universal's `@/lib/tts` engine (data-URL <audio>) instead of the
// desktop streaming-voice pipeline.
//
// The 'preparing' → 'speaking' → 'idle' transitions are driven by the
// `$ttsSpeaking` subscription in store/voice-playback; here we only stamp the
// initiating source/message and clear on failure.
export async function playSpeechText(
  text: string,
  // messageId is optional: read-aloud passes the message being read; the ported
  // voice-conversation replies aren't tied to a message row (source-only).
  { messageId, source }: { messageId?: string; source: Exclude<VoicePlaybackSource, null> }
): Promise<void> {
  $voicePlayback.set({ source, messageId: messageId ?? null, status: 'preparing' })

  try {
    await speakNow(text)

    // speakNow resolves once playback has begun (or bailed on empty/error). If
    // no audio started, the subscription never promoted us to 'speaking' — drop
    // back to idle so the button doesn't stick on "Preparing…".
    if ($voicePlayback.get().status === 'preparing') {
      resetVoicePlayback()
    }
  } catch (error) {
    resetVoicePlayback()
    throw error
  }
}

/**
 * Like `playSpeechText`, but resolves only once the clip has actually FINISHED
 * (or was interrupted). The voice-conversation loop awaits this so it re-arms the
 * mic when the assistant stops speaking, not the instant playback starts — the gap
 * `speakNow` alone leaves. Never rejects; returns how playback ended.
 */
export async function playSpeechTextUntilDone(
  text: string,
  { messageId, source }: { messageId?: string; source: Exclude<VoicePlaybackSource, null> }
): Promise<SpeechEnd> {
  $voicePlayback.set({ source, messageId: messageId ?? null, status: 'preparing' })

  const result = await speakUntilDone(text)

  // If nothing ever started, the $ttsSpeaking subscription never promoted us off
  // 'preparing' — drop back to idle. (On a real playback the subscription has
  // already reset to idle by the time `done` settles.)
  if ($voicePlayback.get().status === 'preparing') {
    resetVoicePlayback()
  }

  return result
}

export function stopVoicePlayback(): void {
  stopSpeaking()
  resetVoicePlayback()
}
