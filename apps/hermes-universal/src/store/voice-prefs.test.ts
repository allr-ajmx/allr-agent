import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ profile: { value: null as null | string } }))

vi.mock('@/hermes', () => ({
  apiRequestProfile: () => h.profile.value,
  getHermesConfigRecord: vi.fn(async () => ({ voice: { auto_tts: true }, model: 'x' })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'

import {
  $autoSpeakReplies,
  $voiceInputGain,
  $voiceInputThreshold,
  setAutoSpeakReplies,
  setVoiceLevel
} from './voice-prefs'

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
 * Levels (MJXHRM-90). Same optimistic write-back shape as the switch above, plus
 * a sanitizer — the config file is hand-editable and the gateway does not
 * type-check these keys.
 */
describe('voice-prefs (levels)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    $voiceInputGain.set(3)
    $voiceInputThreshold.set(0.075)
  })

  it('persists a level under its own voice.* key without disturbing the record', async () => {
    load.mockResolvedValueOnce({ voice: { auto_tts: true }, model: 'x' } as never)
    await setVoiceLevel('inputThreshold', 0.2)

    expect($voiceInputThreshold.get()).toBe(0.2)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'x',
        voice: expect.objectContaining({ auto_tts: true, input_threshold: 0.2 })
      })
    )
  })

  it('reverts the slider when the config write fails', async () => {
    load.mockResolvedValueOnce({ voice: {}, model: 'x' } as never)
    save.mockRejectedValueOnce(new Error('nope'))
    await expect(setVoiceLevel('inputGain', 8)).rejects.toThrow()
    expect($voiceInputGain.get()).toBe(3)
  })

  it('never persists a value outside the range the engine accepts', async () => {
    load.mockResolvedValue({ voice: {}, model: 'x' } as never)
    // 60 is past Rust's LEVEL_GAIN_RANGE, which would clamp it silently — so the
    // slider and the engine would disagree about what is stored.
    await setVoiceLevel('inputGain', 60)
    expect($voiceInputGain.get()).toBe(20)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ voice: expect.objectContaining({ input_gain: 20 }) }))
  })

  it('refuses a non-numeric value rather than writing NaN into the config', async () => {
    load.mockResolvedValue({ voice: {}, model: 'x' } as never)
    // A NaN threshold makes `rms >= level` false forever — a mic that never hears.
    await setVoiceLevel('inputThreshold', 'loud')
    expect($voiceInputThreshold.get()).toBe(0.075)
    expect(save).not.toHaveBeenCalled()
  })
})

/**
 * Seeding (MJXHRM-389). The old `seedAutoSpeak` had NO callers, so
 * `$autoSpeakReplies` stayed at its `false` default for the whole app run: a
 * user with `voice.auto_tts: true` saw the composer's speaker button off, and
 * the first click WROTE `false`.
 *
 * `vi.resetModules()` per test because the seed latch is module state — that
 * latch is itself a thing worth pinning, so it cannot be reset from inside.
 */
describe('voice-prefs seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    h.profile.value = null
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

  // Every atom in this module is a config mirror WITH a write-back setter, so an
  // unseeded one shows the default over a config that says otherwise and then
  // writes that default back on the first drag — MJXHRM-389 exactly.
  it('adopts every persisted level, not just the toggles', async () => {
    load.mockResolvedValue({
      voice: { auto_tts: false, input_gain: 5.5, input_threshold: 0.3, bargein_threshold: 0.5, output_volume: 0.4 },
      model: 'x'
    } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()

    expect(prefs.$voiceInputGain.get()).toBe(5.5)
    expect(prefs.$voiceInputThreshold.get()).toBe(0.3)
    expect(prefs.$voiceBargeinThreshold.get()).toBe(0.5)
    expect(prefs.$voiceOutputVolume.get()).toBe(0.4)
    expect(prefs.conversationVoiceVad()).toEqual({ levelGain: 5.5, speechLevel: 0.3, bargeinSpeechLevel: 0.5 })
  })

  it('falls back to the tuned default for a level the config holds as junk', async () => {
    load.mockResolvedValue({ voice: { input_threshold: 'very loud', output_volume: null }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()

    expect(prefs.$voiceInputThreshold.get()).toBe(prefs.DEFAULT_VOICE_LEVELS.inputThreshold)
    expect(prefs.$voiceOutputVolume.get()).toBe(prefs.DEFAULT_VOICE_LEVELS.outputVolume)
  })

  it('reads the config ONCE however many surfaces ask', async () => {
    load.mockResolvedValue({ voice: { auto_tts: true }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()
    await prefs.seedVoicePrefs()

    expect(load).toHaveBeenCalledTimes(1)
  })

  // A profile switch re-points every profileScoped() REST call at a DIFFERENT
  // config file. A once-only latch left these atoms mirroring the profile the
  // app booted into, which is the same "the control shows something the config
  // doesn't say" defect one switch away.
  it('re-reads after a gateway profile switch', async () => {
    load.mockResolvedValue({ voice: { auto_tts: true, input_gain: 4 }, model: 'x' } as never)
    const prefs = await import('./voice-prefs')

    await prefs.seedVoicePrefs()
    expect(prefs.$voiceInputGain.get()).toBe(4)

    h.profile.value = 'research'
    load.mockResolvedValue({ voice: { auto_tts: false, input_gain: 9 }, model: 'x' } as never)
    await prefs.seedVoicePrefs()

    expect(load).toHaveBeenCalledTimes(2)
    expect(prefs.$voiceInputGain.get()).toBe(9)
    expect(prefs.$autoSpeakReplies.get()).toBe(false)
  })

  it('leaves the defaults alone when the config cannot be read, and retries next time', async () => {
    load.mockRejectedValueOnce(new Error('gateway down'))
    const prefs = await import('./voice-prefs')

    await expect(prefs.seedVoicePrefs()).resolves.toBeUndefined()
    expect(prefs.$autoSpeakReplies.get()).toBe(false)
    expect(prefs.$thinkingSoundEnabled.get()).toBe(true)
    expect(prefs.$voiceInputGain.get()).toBe(prefs.DEFAULT_VOICE_LEVELS.inputGain)

    // A boot-time failure must not pin the defaults for the whole run.
    load.mockResolvedValue({ voice: { auto_tts: true }, model: 'x' } as never)
    await prefs.seedVoicePrefs()
    expect(prefs.$autoSpeakReplies.get()).toBe(true)
  })
})
