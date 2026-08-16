import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useOnProfileSwitch } from '@/app/hooks/use-on-profile-switch'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Mic, SlidersHorizontal, Volume2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import {
  $voiceBargeinThreshold,
  $voiceInputGain,
  $voiceInputThreshold,
  $voiceOutputVolume,
  seedVoicePrefs,
  setVoiceLevel,
  VOICE_LEVEL_RANGES,
  type VoiceLevelName
} from '@/store/voice-prefs'
import { pauseWakeForVoice, resumeWakeAfterVoice } from '@/store/wake-word'
import { voiceEngine } from '@/voice/engine'
import { VoiceBusyError } from '@/voice/errors'
import type { VoiceLease } from '@/voice/types'

import { ListRow, SettingsSection } from './primitives'

// Settings → Voice → Levels (MJXHRM-90).
//
// Universal has no acoustic echo cancellation, so the assistant hearing its own
// speakers is a real failure mode and a per-user pair of thresholds — a normal
// onset gate and a HIGHER barge-in gate — is the mitigation. A threshold the user
// cannot see their own level against is unusable, which is why the meter is the
// load-bearing part of this panel rather than a decoration.
//
// The meter never runs on its own: it opens the microphone only while the user
// holds it open with the button below, tears the session down on stop, on
// unmount, and on a hard cap — and leases at a priority that can never interrupt
// a real conversation.

/** Hard cap on one meter session. A settings page left open must not hold the
 *  microphone forever; the user re-presses to keep going. */
const MAX_METER_MS = 60_000

/** The level is a fraction of full scale; the interesting band for speech sits
 *  well under half, so the meter draws 0..1 but labels in percent. */
const pct = (value: number) => `${Math.round(value * 100)}%`

interface MeterState {
  running: boolean
  level: number
  peak: number
}

/**
 * Own one meter-only voice session.
 *
 * The session is opened with `levelGain: 1` and the gain is applied HERE, in JS.
 * Rust takes `level_gain` once per session, so a gain-scaled session would have
 * to be torn down and the device reopened on every drag of the gain slider. The
 * arithmetic is identical either way — Rust computes `min(1, rms * gain)` and so
 * does this — so the meter tracks the slider instantly and the numbers still
 * describe exactly what a real conversation will see.
 */
function useLevelMeter(gain: number): MeterState & { toggle: () => void; stop: () => void } {
  const [running, setRunning] = useState(false)
  const [raw, setRaw] = useState(0)
  const [rawPeak, setRawPeak] = useState(0)
  const leaseRef = useRef<VoiceLease | null>(null)
  const timerRef = useRef<number | null>(null)
  const { t } = useI18n()
  const copy = t.settings.voiceLevels

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const lease = leaseRef.current
    leaseRef.current = null
    setRunning(false)
    setRaw(0)

    if (lease) {
      void lease
        .close()
        .catch(() => undefined)
        // The wake listener yielded the device to us; give it back, whatever
        // happened in between.
        .finally(() => void resumeWakeAfterVoice())
    }
  }, [])

  const start = useCallback(async () => {
    setRawPeak(0)
    // Same reason the conversation loop does this: on a `capture: "local"`
    // backend the microphone is held by the gateway host, and only `wake.pause`
    // frees that one — the engine's own priority policy can't.
    await pauseWakeForVoice()

    try {
      // No transcription target: a monitor session never finalizes a turn, so
      // there is nothing to POST and deliberately nowhere to POST it.
      const lease = await voiceEngine.open('meter', {
        target: { baseUrl: '', headers: {} },
        vad: { levelGain: 1 }
      })

      leaseRef.current = lease
      setRunning(true)

      lease.on(event => {
        if (event.type === 'level') {
          setRaw(event.level)
          setRawPeak(previous => Math.max(previous, event.level))
        } else if (event.type === 'state' && event.state === 'closed') {
          // Preempted (a conversation started) or the device dropped.
          stop()
        } else if (event.type === 'error') {
          stop()
        }
      })

      await lease.arm('monitor')
      timerRef.current = window.setTimeout(stop, MAX_METER_MS)
    } catch (error) {
      leaseRef.current = null
      setRunning(false)
      void resumeWakeAfterVoice()
      notifyError(error, error instanceof VoiceBusyError ? copy.meterBusy : copy.meterFailed)
    }
  }, [copy.meterBusy, copy.meterFailed, stop])

  const toggle = useCallback(() => {
    if (leaseRef.current) {
      stop()
    } else {
      void start()
    }
  }, [start, stop])

  // Leaving the page must release the microphone. `stop` is stable, so this runs
  // on unmount only.
  useEffect(() => stop, [stop])

  return {
    running,
    level: Math.min(1, raw * gain),
    peak: Math.min(1, rawPeak * gain),
    stop,
    toggle
  }
}

/** One labeled slider bound to a persisted level. */
function LevelRow({
  description,
  format,
  name,
  onCommit,
  title,
  value
}: {
  description: string
  format: (value: number) => string
  name: VoiceLevelName
  onCommit: (value: number) => void
  title: string
  value: number
}) {
  const range = VOICE_LEVEL_RANGES[name]

  return (
    <ListRow
      action={
        <div className="flex items-center gap-3">
          <input
            aria-label={title}
            className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)"
            max={range.max}
            min={range.min}
            onChange={event => onCommit(Number(event.target.value))}
            step={range.step}
            style={{ accentColor: 'var(--dt-primary)' }}
            type="range"
            value={value}
          />
          <span className="w-12 text-end text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)">
            {format(value)}
          </span>
        </div>
      }
      description={description}
      title={title}
    />
  )
}

export function VoiceLevelsPanel() {
  const { t } = useI18n()
  const copy = t.settings.voiceLevels
  const gain = useStore($voiceInputGain)
  const threshold = useStore($voiceInputThreshold)
  const bargein = useStore($voiceBargeinThreshold)
  const outputVolume = useStore($voiceOutputVolume)
  const meter = useLevelMeter(gain)

  // This panel can be the FIRST voice surface a user reaches — Settings opens as
  // its own screen (and its own Activity on Android), with no composer mounted to
  // have seeded these atoms. Seeding here is what stops the sliders rendering the
  // defaults over a config that says otherwise, and then writing those defaults
  // back on the first drag (MJXHRM-389's exact failure).
  useEffect(() => void seedVoicePrefs(), [])
  useOnProfileSwitch(() => {
    meter.stop()
    void seedVoicePrefs()
  })

  const commit = (name: VoiceLevelName, value: number) => {
    void setVoiceLevel(name, value).catch(error => notifyError(error, copy.saveFailed))
  }

  return (
    <>
      <SettingsSection icon={SlidersHorizontal} title={copy.title}>
        <div className="pb-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {copy.intro}
        </div>

        <ListRow
          action={
            <Button onClick={meter.toggle} size="sm" variant={meter.running ? 'secondary' : 'outline'}>
              <Mic className="size-4" />
              {meter.running ? copy.meterStop : copy.meterStart}
            </Button>
          }
          below={
            <div className="mt-3">
              {/* 0..1 of full scale, with both thresholds drawn ON the bar: the
                  point of the meter is reading your own level AGAINST the gates. */}
              <div className="relative h-3 w-full overflow-hidden rounded-full bg-(--ui-stroke-tertiary)">
                <div
                  className={cn(
                    'absolute inset-y-0 start-0 rounded-full transition-[width] duration-75',
                    meter.level >= bargein
                      ? 'bg-destructive'
                      : meter.level >= threshold
                        ? 'bg-primary'
                        : 'bg-muted-foreground'
                  )}
                  style={{ width: `${Math.min(100, meter.level * 100)}%` }}
                />
                <div
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-foreground/70"
                  style={{ left: `${Math.min(100, threshold * 100)}%` }}
                />
                <div
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-destructive"
                  style={{ left: `${Math.min(100, bargein * 100)}%` }}
                />
              </div>
              <div
                className="mt-1.5 flex justify-between text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)"
                role="status"
              >
                <span>{copy.meterLevel(pct(meter.level))}</span>
                <span>{copy.meterPeak(pct(meter.peak))}</span>
              </div>
            </div>
          }
          description={meter.running ? copy.meterRunningDesc : copy.meterDesc}
          title={copy.meterTitle}
          wide
        />

        <LevelRow
          description={copy.gainDesc}
          format={value => `×${value.toFixed(2)}`}
          name="inputGain"
          onCommit={value => commit('inputGain', value)}
          title={copy.gainTitle}
          value={gain}
        />

        <LevelRow
          description={copy.thresholdDesc}
          format={pct}
          name="inputThreshold"
          onCommit={value => commit('inputThreshold', value)}
          title={copy.thresholdTitle}
          value={threshold}
        />

        <LevelRow
          description={copy.bargeinDesc}
          format={pct}
          name="bargeinThreshold"
          onCommit={value => commit('bargeinThreshold', value)}
          title={copy.bargeinTitle}
          value={bargein}
        />
      </SettingsSection>

      <SettingsSection icon={Volume2} title={copy.outputSectionTitle}>
        <LevelRow
          description={copy.outputDesc}
          format={pct}
          name="outputVolume"
          onCommit={value => commit('outputVolume', value)}
          title={copy.outputTitle}
          value={outputVolume}
        />
      </SettingsSection>
    </>
  )
}
