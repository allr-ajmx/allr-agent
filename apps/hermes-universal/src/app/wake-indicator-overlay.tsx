import './wake-indicator-overlay.css'

import { useStore } from '@nanostores/react'

import { $wakeIndicator } from '@/store/wake-indicator'

/**
 * The wake indicator's in-window presentation — one subscriber to
 * `$wakeIndicator` (see that module for the state machine and the MJXHRM-228
 * seam).
 *
 * Renders NOTHING while hidden, which is what makes it safe to mount in every
 * window root: only the window that armed the detector ever receives
 * `wake.detected`, so every other root holds an atom that stays 'hidden' for the
 * life of the process.
 *
 * `aria-hidden`, deliberately, and desktop does the same: it is a redundant cue
 * for a state a screen-reader user already hears announced by the conversation
 * pill and the wake chime. Announcing a purely decorative light that pulses for
 * the length of a conversation would be noise, not access.
 */
export function WakeIndicatorOverlay() {
  const state = useStore($wakeIndicator)

  if (state === 'hidden') {
    return null
  }

  return (
    <div aria-hidden className="wake-indicator-surface" data-state={state} data-testid="wake-indicator">
      <div className="wake-indicator-light" />
    </div>
  )
}
