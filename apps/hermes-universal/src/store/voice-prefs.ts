import { apiRequestProfile, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { atom } from '@/store/atom'
import type { VoiceVad } from '@/voice/types'

// "Read replies aloud" — mirrors the canonical `voice.auto_tts` config key (also
// the Settings → Voice switch, honored by the messaging gateway) so the composer
// toggle and the settings switch are one source of truth. Ported from
// apps/desktop/src/store/voice-prefs.ts.
export const $autoSpeakReplies = atom<boolean>(false)

// `voice.thinking_sound` — the ambient bubble blips played while the agent works
// during a voice conversation (lib/thinking-sound.ts). Defaults to TRUE, which is
// the backend's default (hermes_cli/config_defaults.py:1624); seeding below is
// what makes a user who turned it off actually get silence.
export const $thinkingSoundEnabled = atom<boolean>(true)

// ── Voice levels (MJXHRM-90) ────────────────────────────────────────────────
// Every default here is the tuned constant Rust already ships, so an unset config
// and a config that happens to hold the defaults behave identically:
//   input gain           → `DEFAULT_LEVEL_GAIN` / `VoiceConfig::level_gain` (3.0)
//   input threshold      → `VoiceConfig::speech_level` (0.075)
//   barge-in threshold   → `VoiceConfig::bargein_speech_level` (0.16)
// Output volume has no Rust side at all — it is `<audio>.volume` / a master
// GainNode in lib/tts.ts.

export const DEFAULT_VOICE_LEVELS = {
  inputGain: 3.0,
  inputThreshold: 0.075,
  bargeinThreshold: 0.16,
  outputVolume: 1.0
} as const

/** Bounds the sliders — and the sanitizer — work in. `inputGain` mirrors Rust's
 *  `LEVEL_GAIN_RANGE`; going outside it there is clamped anyway, so the UI must
 *  not offer values the engine will quietly refuse. */
export const VOICE_LEVEL_RANGES = {
  inputGain: { min: 0.25, max: 20, step: 0.25 },
  inputThreshold: { min: 0, max: 1, step: 0.005 },
  bargeinThreshold: { min: 0, max: 1, step: 0.005 },
  outputVolume: { min: 0, max: 1, step: 0.05 }
} as const

export const $voiceInputGain = atom<number>(DEFAULT_VOICE_LEVELS.inputGain)
export const $voiceInputThreshold = atom<number>(DEFAULT_VOICE_LEVELS.inputThreshold)
export const $voiceBargeinThreshold = atom<number>(DEFAULT_VOICE_LEVELS.bargeinThreshold)
export const $voiceOutputVolume = atom<number>(DEFAULT_VOICE_LEVELS.outputVolume)

/** The config key each level atom mirrors. One table so seeding, persisting and
 *  the settings panel can never name different keys. */
export const VOICE_LEVEL_KEYS = {
  inputGain: 'input_gain',
  inputThreshold: 'input_threshold',
  bargeinThreshold: 'bargein_threshold',
  outputVolume: 'output_volume'
} as const

export type VoiceLevelName = keyof typeof VOICE_LEVEL_KEYS

const LEVEL_ATOMS = {
  inputGain: $voiceInputGain,
  inputThreshold: $voiceInputThreshold,
  bargeinThreshold: $voiceBargeinThreshold,
  outputVolume: $voiceOutputVolume
} as const

/**
 * Hold a persisted value inside its slider's range, or fall back to the default.
 *
 * The config file is hand-editable and the gateway does not type-check these
 * keys, so `"loud"`, `null` and `NaN` all have to land somewhere sane. Rust
 * clamps the input numbers again on its own side — this one exists so the SLIDER
 * has something to render and the user is never shown a control whose position
 * doesn't match what the engine will use.
 */
export function sanitizeVoiceLevel(name: VoiceLevelName, value: unknown): number {
  const range = VOICE_LEVEL_RANGES[name]
  const parsed = typeof value === 'number' ? value : Number(value)

  if (value === null || value === undefined || value === '' || !Number.isFinite(parsed)) {
    return DEFAULT_VOICE_LEVELS[name]
  }

  return Math.min(range.max, Math.max(range.min, parsed))
}

/**
 * The `vad` overrides a new `voice_open` should carry for a full conversation.
 *
 * `levelGain` is the only field dictation wants too (it just scales the meter);
 * the thresholds are conversation-only, because push-to-talk deliberately runs
 * with `speechLevel: 0` so it never auto-ends.
 */
export function conversationVoiceVad(): VoiceVad {
  return {
    levelGain: $voiceInputGain.get(),
    speechLevel: $voiceInputThreshold.get(),
    bargeinSpeechLevel: $voiceBargeinThreshold.get()
  }
}

/** The gain alone, for sessions that want the meter on the user's scale but must
 *  keep their own turn thresholds (dictation, the settings meter). */
export function voiceInputGain(): number {
  return $voiceInputGain.get()
}

/** REST scope the atoms were last filled from. `undefined` = never seeded, which
 *  is deliberately distinct from `null` (the gateway's own primary profile). */
let seededScope: string | null | undefined

/**
 * Seed the voice preference atoms from the gateway config.
 *
 * ONE config read for every key — `voice.auto_tts`, `voice.thinking_sound` and
 * the four level keys — because they are read at the same moment (a voice
 * surface mounting) and several round trips for one record is several chances to
 * disagree.
 *
 * This used to exist as `seedAutoSpeak` and was never called from anywhere
 * (MJXHRM-389): `$autoSpeakReplies` therefore started `false` in every session
 * regardless of config, so a user with `voice.auto_tts: true` saw the composer's
 * speaker button OFF, and their first click on it WROTE `false` — turning off a
 * setting they had asked for by pressing the control that claims to turn it on.
 * EVERY atom in this module is a config mirror with a write-back setter, so every
 * atom added here has to be seeded or it reproduces that bug exactly.
 *
 * Keyed on the REST profile scope rather than a boolean latch (MJXHRM-90): a
 * profile switch re-points every `profileScoped()` call at another config file,
 * and a once-only latch left these atoms mirroring the profile the app booted
 * into — the same "the control shows something the config doesn't say" defect,
 * one gateway-profile switch away. Callers poke this on mount AND on profile
 * switch; the scope check makes both cheap.
 *
 * Best-effort: a config that cannot be read leaves the defaults in place AND
 * leaves the scope unseeded, so the next surface to ask retries instead of
 * pinning the defaults for the rest of the run.
 */
export async function seedVoicePrefs(): Promise<void> {
  const scope = apiRequestProfile()

  if (seededScope === scope) {
    return
  }

  seededScope = scope

  try {
    const record = await getHermesConfigRecord()
    const voice = record.voice && typeof record.voice === 'object' ? (record.voice as Record<string, unknown>) : {}
    $autoSpeakReplies.set(Boolean(voice.auto_tts))
    // Absent means the backend default (on); only an explicit `false` mutes it.
    $thinkingSoundEnabled.set(voice.thinking_sound !== false)

    for (const name of Object.keys(LEVEL_ATOMS) as VoiceLevelName[]) {
      LEVEL_ATOMS[name].set(sanitizeVoiceLevel(name, voice[VOICE_LEVEL_KEYS[name]]))
    }
  } catch {
    // Keep the defaults, and let the next caller try again.
    seededScope = undefined
  }
}

/** Read-modify-write the whole record under `voice`, the same path Settings uses. */
async function writeVoiceKey(key: string, value: unknown): Promise<void> {
  const record = await getHermesConfigRecord()
  const voice = record.voice && typeof record.voice === 'object' ? (record.voice as Record<string, unknown>) : {}
  await saveHermesConfig({ ...record, voice: { ...voice, [key]: value } })
}

/** Flip the preference and persist it. Optimistic, reverts on write failure. */
export async function setAutoSpeakReplies(enabled: boolean): Promise<void> {
  const previous = $autoSpeakReplies.get()

  if (previous === enabled) {
    return
  }

  $autoSpeakReplies.set(enabled)

  try {
    await writeVoiceKey('auto_tts', enabled)
  } catch (error) {
    $autoSpeakReplies.set(previous)
    throw error
  }
}

/**
 * Move one level and persist it. Same optimistic shape as the switch above: the
 * atom moves first so the slider and the live meter track the drag, and reverts
 * if the write fails rather than showing a position the config doesn't hold.
 *
 * The value is sanitized on the way in, so a caller that hands over a raw
 * `<input type="range">` string cannot persist `NaN` into the config.
 */
export async function setVoiceLevel(name: VoiceLevelName, value: unknown): Promise<void> {
  const next = sanitizeVoiceLevel(name, value)
  const atomRef = LEVEL_ATOMS[name]
  const previous = atomRef.get()

  if (previous === next) {
    return
  }

  atomRef.set(next)

  try {
    await writeVoiceKey(VOICE_LEVEL_KEYS[name], next)
  } catch (error) {
    atomRef.set(previous)
    throw error
  }
}
