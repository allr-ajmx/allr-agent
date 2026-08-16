import '@/app/wake-indicator-overlay.css'

import type { WakeIndicatorState } from '@/store/wake-indicator'

/**
 * The light itself — the only place the wake indicator's look is written down.
 *
 * Two surfaces draw it: the in-window pill (`app/wake-indicator-overlay.tsx`)
 * and the native satellite (`wake-indicator-window.tsx`). They differ in WHERE
 * they are, not in what they show, and a second copy of the markup would be a
 * second chance for the two to drift into looking like different features.
 *
 * The same rules position it in both: the surface is `position: fixed` across
 * the top edge with the light centred in it, which is the top of the app window
 * in one case and the top of the whole output in the other (a layer-shell
 * satellite is output-sized — `surface/layer_shell.rs` anchors all four edges).
 *
 * `aria-hidden`, deliberately, and desktop does the same: it is a redundant cue
 * for a state a screen-reader user already hears announced by the conversation
 * pill and the wake chime. Announcing a purely decorative light that pulses for
 * the length of a conversation would be noise, not access.
 */
export function WakeIndicatorLight({ state }: { state: Exclude<WakeIndicatorState, 'hidden'> }) {
  return (
    <div aria-hidden className="wake-indicator-surface" data-state={state} data-testid="wake-indicator">
      <div className="wake-indicator-light" />
    </div>
  )
}
