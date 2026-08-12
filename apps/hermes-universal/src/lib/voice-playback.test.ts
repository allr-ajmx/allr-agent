/**
 * The sanitizer has its own exhaustive tests (`speech-text.test.ts`). What is
 * worth pinning here is the WIRING (MJXHRM-369): that the whole-clip entry
 * points hand the engine sanitized text, and — the part a future refactor is
 * most likely to get wrong — that they hand it the sanitized text rather than
 * sanitizing and then passing the original.
 */

import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const speakNow = vi.fn(async () => undefined)
const speakUntilDone = vi.fn(async () => 'finished' as const)

// `$ttsSpeaking` is mocked too, not just the two speak functions: importing
// `lib/voice-playback` pulls in `store/voice-playback`, which subscribes to it
// at module scope and would throw on a mock that omits it.
vi.mock('@/lib/tts', () => ({
  $ttsSpeaking: atom(false),
  speakNow,
  speakUntilDone,
  stopSpeaking: vi.fn()
}))

const MARKDOWN = '## Heading\n\nSome **bold** and `code` and a [link](https://example.com/x).'
const SPOKEN = 'Heading. Some bold and code and a link.'

describe('read-aloud sanitizes before speaking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('strips markdown on the play path', async () => {
    const { playSpeechText } = await import('./voice-playback')

    await playSpeechText(MARKDOWN, { source: 'read-aloud' })

    expect(speakNow).toHaveBeenCalledWith(SPOKEN)
  })

  it('strips markdown on the play-until-done path the voice loop uses', async () => {
    const { playSpeechTextUntilDone } = await import('./voice-playback')

    await playSpeechTextUntilDone(MARKDOWN, { source: 'read-aloud' })

    expect(speakUntilDone).toHaveBeenCalledWith(SPOKEN)
  })

  it('never voices a fenced code block', async () => {
    const { playSpeechText } = await import('./voice-playback')

    await playSpeechText('Try this:\n```ts\nconst secret = 1\n```\nDone.', { source: 'read-aloud' })

    const spoken = String(speakNow.mock.calls.at(0)?.at(0) ?? '')

    expect(spoken).not.toContain('const secret')
    expect(spoken).toContain('code block omitted')
  })

  // The read-aloud button and `useAutoSpeakReplies` both wrap this call in a
  // `catch → notifyError`. Until MJXHRM-369 neither was reachable: the engine
  // swallowed a failed synthesis and resolved exactly as it does on success, so
  // the button flashed "Preparing…" and went quietly idle.
  it('surfaces a failed synthesis to the caller and drops back to idle', async () => {
    const { playSpeechText } = await import('./voice-playback')
    const { $voicePlayback } = await import('@/store/voice-playback')

    speakNow.mockRejectedValueOnce(new Error('speech synthesis returned no audio'))

    await expect(playSpeechText('hello', { source: 'read-aloud' })).rejects.toThrow(/no audio/)
    expect($voicePlayback.get().status).toBe('idle')
  })
})
