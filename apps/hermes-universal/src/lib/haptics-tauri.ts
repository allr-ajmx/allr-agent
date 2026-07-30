import { impactFeedback, type ImpactFeedbackStyle, vibrate } from '@tauri-apps/plugin-haptics'
import { defaultPatterns, type HapticInput, type TriggerOptions, type Vibration } from 'web-haptics'

import type { HapticTrigger } from '@/lib/haptics'
import { IS_IOS } from '@/lib/platform'

// Mobile backend for the `@/lib/haptics` seam (registered by
// components/haptics-provider.tsx). Desktop registers web-haptics instead; this
// file exists because `@tauri-apps/plugin-haptics` is the only way to reach the
// Taptic Engine / Android VibrationEffect from inside a Tauri webview.
//
// WHAT THIS DOES NOT DO: recover the intent. `lib/haptics.ts` is kept
// byte-identical to desktop's, and its seam passes only the pulse pattern —
// `HAPTIC_INTENTS` is module-private and the intent is not forwarded. So this is
// a *renderer*: it treats the pattern as a rhythm-and-intensity score and plays
// it on whatever primitives the platform has. It does not classify patterns back
// into intents; that would be guesswork, and two intents that share a pattern
// object (success / streamDone are both `friendlySuccess`) are indistinguishable
// by construction.
//
// The cost is that iOS's native notificationFeedback('success'|'warning'|'error')
// is never used — picking it needs the intent. If the feel is wrong on device,
// the fix is one additive line in lib/haptics.ts:
//   registeredTrigger(config.pattern, config.options, intent)
// plus `intent` on the HapticTrigger type. Desktop's web-haptics trigger ignores
// extra arguments, so desktop is unaffected.
//
// Input normalization and intensity semantics deliberately mirror web-haptics'
// own (`C()` and `M()` in its bundle) so a given pattern reads the same on both
// backends: `options.intensity` is the per-pulse FALLBACK for pulses that don't
// declare one — not a master multiplier — and it defaults to 0.5.

// iOS impact styles, ordered by ascending intensity. A pulse's intensity picks
// the closest style; duration is not expressible (an impact is a transient).
const IMPACT_STYLES: { max: number; style: ImpactFeedbackStyle }[] = [
  { max: 0.35, style: 'soft' },
  { max: 0.55, style: 'light' },
  { max: 0.75, style: 'medium' },
  { max: 0.9, style: 'rigid' },
  { max: Infinity, style: 'heavy' }
]

// web-haptics' own default when neither the pulse nor the options declare one.
const FALLBACK_INTENSITY = 0.5

function styleFor(intensity: number): ImpactFeedbackStyle {
  return IMPACT_STYLES.find(entry => intensity < entry.max)!.style
}

// `HapticInput` is a wide union (number | string | HapticPattern | HapticPreset).
// lib/haptics.ts only ever passes a Vibration[], but normalize defensively so a
// stray preset name or bare duration doesn't throw inside a UI event handler.
// Pulses may legitimately come back without an `intensity` — resolved later
// against the options fallback, exactly as web-haptics does.
function toPulses(input: HapticInput | undefined): Vibration[] {
  if (input === undefined) {
    return [{ duration: 25, intensity: 0.7 }] // web-haptics' no-argument default
  }

  if (typeof input === 'number') {
    return [{ duration: input }]
  }

  if (typeof input === 'string') {
    const preset = (defaultPatterns as Record<string, { pattern: Vibration[] } | undefined>)[input]

    if (!preset) {
      console.warn(`[haptics-tauri] Unknown preset: "${input}"`)

      return []
    }

    return preset.pattern.map(pulse => ({ ...pulse }))
  }

  if (Array.isArray(input)) {
    return input.map(pulse => (typeof pulse === 'number' ? { duration: pulse } : { ...pulse }))
  }

  return input.pattern?.map(pulse => ({ ...pulse })) ?? []
}

async function playPulse(pulse: Vibration, fallbackIntensity: number): Promise<void> {
  const intensity = Math.max(0, Math.min(1, pulse.intensity ?? fallbackIntensity))
  const duration = Math.max(1, Math.round(pulse.duration))

  try {
    if (IS_IOS) {
      // Taptic Engine: intensity survives, duration doesn't.
      await impactFeedback(styleFor(intensity))
    } else {
      // Android: duration survives, intensity doesn't (the plugin's vibrate()
      // takes no amplitude). Rhythm is what carries most of a pattern's identity,
      // so this is the better trade here.
      await vibrate(duration)
    }
  } catch {
    // No Tauri runtime, no actuator, or permission denied. The Web Vibration API
    // is the same fallback the previous store/haptics.ts used.
    try {
      navigator.vibrate?.(duration)
    } catch {
      /* Vibration API unsupported — nothing further to try. */
    }
  }
}

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

// Walks the pattern, honouring each pulse's `delay` as a gap BEFORE it (matching
// web-haptics' semantics, so the same pattern reads the same on both backends).
export const tauriHapticTrigger: HapticTrigger = async (
  input?: HapticInput,
  options?: TriggerOptions
): Promise<void> => {
  const pulses = toPulses(input)

  if (pulses.length === 0) {
    return
  }

  const fallbackIntensity = Math.max(0, Math.min(1, options?.intensity ?? FALLBACK_INTENSITY))

  for (const pulse of pulses) {
    if (!Number.isFinite(pulse.duration) || pulse.duration < 0) {
      console.warn('[haptics-tauri] Invalid vibration values. Durations and delays must be finite and non-negative.')

      return
    }

    if (pulse.delay) {
      await wait(pulse.delay)
    }

    await playPulse(pulse, fallbackIntensity)
  }
}
