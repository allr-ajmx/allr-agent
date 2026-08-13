import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  getHermesConfigRecord: vi.fn(async () => ({ voice: { auto_tts: true }, model: 'x' })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'

import { $autoSpeakReplies, setAutoSpeakReplies } from './voice-prefs'

const save = vi.mocked(saveHermesConfig)
const load = vi.mocked(getHermesConfigRecord)

describe('voice-prefs (auto-speak)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $autoSpeakReplies.set(false)
  })
  afterEach(() => $autoSpeakReplies.set(false))

  it('persists the flag into the whole config record (voice.auto_tts)', async () => {
    load.mockResolvedValueOnce({ voice: { provider: 'edge' }, model: 'x' } as never)
    await setAutoSpeakReplies(true)
    expect($autoSpeakReplies.get()).toBe(true)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'x', voice: expect.objectContaining({ provider: 'edge', auto_tts: true }) })
    )
  })

  it('reverts optimistically when the config write fails', async () => {
    load.mockResolvedValueOnce({ voice: {}, model: 'x' } as never)
    save.mockRejectedValueOnce(new Error('nope'))
    await expect(setAutoSpeakReplies(true)).rejects.toThrow()
    expect($autoSpeakReplies.get()).toBe(false)
  })

  it('is a no-op when the value is unchanged', async () => {
    await setAutoSpeakReplies(false)
    expect(save).not.toHaveBeenCalled()
  })
})

/**
 * Seeding (MJXHRM-389). The old `seedAutoSpeak` had NO callers, so
 * `$autoSpeakReplies` stayed at its `false` default for the whole app run: a
 * user with `voice.auto_tts: true` saw the composer's speaker button off, and
 * the first click WROTE `false`.
 *
 * `vi.resetModules()` per test because the "once" latch is module state — that
 * latch is itself a thing worth pinning, so it cannot be reset from inside.
 */
describe('voice-prefs seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('adopts voice.auto_tts from the gateway config', async () => {
    load.mockResolvedValue({ voice: { auto_tts: true }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()

    expect(prefs.$autoSpeakReplies.get()).toBe(true)
  })

  it('adopts an explicit voice.thinking_sound: false', async () => {
    load.mockResolvedValue({ voice: { auto_tts: false, thinking_sound: false }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()

    expect(prefs.$thinkingSoundEnabled.get()).toBe(false)
  })

  it("keeps thinking sound on when the key is absent — that is the backend's default", async () => {
    load.mockResolvedValue({ voice: { auto_tts: false }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()

    expect(prefs.$thinkingSoundEnabled.get()).toBe(true)
  })

  it('reads the config ONCE however many surfaces ask', async () => {
    load.mockResolvedValue({ voice: { auto_tts: true }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()
    await prefs.seedVoicePrefs()

    expect(load).toHaveBeenCalledTimes(1)
  })

  it('leaves the defaults alone when the config cannot be read', async () => {
    load.mockRejectedValue(new Error('gateway down'))
    const prefs = await import('./voice-prefs')

    await expect(prefs.seedVoicePrefs()).resolves.toBeUndefined()
    expect(prefs.$autoSpeakReplies.get()).toBe(false)
    expect(prefs.$thinkingSoundEnabled.get()).toBe(true)
  })
})
