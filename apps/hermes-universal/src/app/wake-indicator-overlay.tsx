import { useEffect } from 'react'

import { WakeIndicatorLight } from '@/app/wake-indicator/light'
import { $nativeWakeIndicator, installNativeWakeIndicator } from '@/app/wake-indicator/native-indicator'
import { useStore } from '@/store/atom'
import { $wakeIndicator } from '@/store/wake-indicator'

/**
 * How the wake indicator is presented IN THIS PROCESS — one subscriber to
 * `$wakeIndicator` (see that module for the state machine).
 *
 * Two presentations, one state. The native light
 * (`app/wake-indicator/native-indicator.ts`) is the one that works when Hermes
 * is not the window you are looking at, which hands-free is the whole point; the
 * in-window pill is the fallback for every platform and session that cannot
 * carry one, and it is a fallback rather than a companion — two lights for one
 * phrase reads as two things having happened.
 *
 * The pill draws while the native surface is opening, deliberately. A beat of
 * both is cosmetic; a beat of neither is the acknowledgement not arriving, which
 * is the failure this whole feature exists to prevent.
 *
 * Renders NOTHING while hidden, which is what makes it safe to mount in every
 * window root: only the window that armed the detector ever receives
 * `wake.detected`, so every other root holds an atom that stays 'hidden' for the
 * life of the process. The driver stands down in those roots too — it refuses
 * inside a satellite, so the light's own window cannot summon another.
 */
export function WakeIndicatorOverlay() {
  const state = useStore($wakeIndicator)
  const native = useStore($nativeWakeIndicator)

  useEffect(() => installNativeWakeIndicator(), [])

  if (state === 'hidden' || native) {
    return null
  }

  return <WakeIndicatorLight state={state} />
}
