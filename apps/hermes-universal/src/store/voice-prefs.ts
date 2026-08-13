import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { atom } from '@/store/atom'

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

let seeded = false

/**
 * Seed the voice preference atoms from the gateway config, once per app run.
 *
 * ONE config read for both keys — `voice.auto_tts` and `voice.thinking_sound` —
 * because they are read at the same moment (the composer mounting) and two
 * round trips for one record is two chances to disagree.
 *
 * This used to exist as `seedAutoSpeak` and was never called from anywhere
 * (MJXHRM-389): `$autoSpeakReplies` therefore started `false` in every session
 * regardless of config, so a user with `voice.auto_tts: true` saw the composer's
 * speaker button OFF, and their first click on it WROTE `false` — turning off a
 * setting they had asked for by pressing the control that claims to turn it on.
 * The caller is `use-composer-voice`, beside the wake-word reconcile, because
 * that is the one effect that already runs once for the main composer.
 *
 * Best-effort: a config that cannot be read leaves the defaults in place.
 */
export async function seedVoicePrefs(): Promise<void> {
  if (seeded) {
    return
  }

  seeded = true

  try {
    const record = await getHermesConfigRecord()
    const voice = record.voice && typeof record.voice === 'object' ? (record.voice as Record<string, unknown>) : {}
    $autoSpeakReplies.set(Boolean(voice.auto_tts))
    // Absent means the backend default (on); only an explicit `false` mutes it.
    $thinkingSoundEnabled.set(voice.thinking_sound !== false)
  } catch {
    // Keep the defaults if config can't be read.
  }
}

/** Flip the preference and persist it (read-modify-write the whole record —
 *  the same path Settings uses). Optimistic, reverts on write failure. */
export async function setAutoSpeakReplies(enabled: boolean): Promise<void> {
  const previous = $autoSpeakReplies.get()

  if (previous === enabled) {
    return
  }

  $autoSpeakReplies.set(enabled)

  try {
    const record = await getHermesConfigRecord()
    const voice = record.voice && typeof record.voice === 'object' ? (record.voice as Record<string, unknown>) : {}
    await saveHermesConfig({ ...record, voice: { ...voice, auto_tts: enabled } })
  } catch (error) {
    $autoSpeakReplies.set(previous)
    throw error
  }
}
