import { useEffect, useState } from 'react'

import { getElevenLabsVoices } from '@/hermes'

import { ConfigSection } from './config-section'
import { enumOptionsFor, voiceFieldVisible } from './helpers'
import { VoiceLevelsPanel } from './voice-levels'

const ELEVENLABS_VOICE_KEY = 'tts.elevenlabs.voice_id'

// Voice config section: the generic schema fields filtered to the active TTS/STT
// provider (voiceFieldVisible), plus a live ElevenLabs voice dropdown. Mirrors
// desktop's ConfigSettings voice wiring — when the backend can list ElevenLabs
// voices, `tts.elevenlabs.voice_id` becomes a named-voice Select instead of free
// text; otherwise it falls back to the generic control.
export function VoiceSection() {
  const [voiceOptions, setVoiceOptions] = useState<string[] | null>(null)
  const [voiceLabels, setVoiceLabels] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false

    getElevenLabsVoices()
      .then(result => {
        if (cancelled || !result.available) {
          return
        }

        setVoiceOptions(result.voices.map(voice => voice.voice_id))
        setVoiceLabels(Object.fromEntries(result.voices.map(voice => [voice.voice_id, voice.label])))
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceOptions(null)
          setVoiceLabels({})
        }
      })

    return () => void (cancelled = true)
  }, [])

  return (
    <ConfigSection
      fieldFilter={voiceFieldVisible}
      // The levels panel goes in the header slot, not beside the section: it has
      // to sit INSIDE the page's own scroll container, and it must stay mounted
      // while the config schema loads (it is backed by the prefs store, not by
      // the schema, so it has nothing to wait for).
      headerSlot={<VoiceLevelsPanel />}
      resolveEnumOptions={(key, value, config) =>
        key === ELEVENLABS_VOICE_KEY
          ? enumOptionsFor(key, value, config, voiceOptions ?? undefined)
          : enumOptionsFor(key, value, config)
      }
      resolveOptionLabels={key => (key === ELEVENLABS_VOICE_KEY ? voiceLabels : undefined)}
      sectionId="voice"
    />
  )
}
