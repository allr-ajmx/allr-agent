import { useEffect, useLayoutEffect, useState } from 'react'

import { WAKE_INDICATOR_STATES, type WakeIndicatorState } from '@/store/wake-indicator'

import { emitWakeIndicatorHello, onWakeIndicatorState } from './channel'
import { WakeIndicatorLight } from './light'

/**
 * `?win=wake` — the native wake light's window (MJXHRM-228).
 *
 * A pure sink. It holds no state machine, subscribes to no store and knows
 * nothing about voice: it draws what the owning window tells it to draw, and it
 * only exists while there is something to draw. Everything about when the light
 * is live is decided once in `store/wake-indicator.ts`.
 *
 * It opens on `detected`, because that is the only state it can be opened FOR —
 * showing that until the first push lands means the light is up during the
 * window's own load, which is most of the phase it is announcing.
 *
 * The window takes no clicks and no focus. Both are refused in Rust
 * (`window.rs`, the `wake` satellite spec) rather than here, because a light
 * that steals focus while you are typing in another application has interrupted
 * the exact thing it was meant to leave alone — and on the layer-shell backend
 * it is the size of the whole output.
 */
export function WakeIndicatorWindowRoot() {
  const [state, setState] = useState<Exclude<WakeIndicatorState, 'hidden'>>('detected')

  useTransparentSurface()

  useEffect(() => {
    let stop: (() => void) | undefined
    let gone = false

    void onWakeIndicatorState(payload => {
      const next = normalize(payload)

      // 'hidden' is not drawn — the owner CLOSES this window for that, and a
      // window that painted nothing while still on screen would be a transparent
      // surface no one could account for.
      if (next && next !== 'hidden') {
        setState(next)
      }
    })
      .then(off => {
        stop = off

        if (gone) {
          off()

          return
        }

        // Only once the listener is registered: this asks for a push, and an
        // answer that outran the listener would be lost — which is the whole
        // failure this handshake exists to prevent.
        void emitWakeIndicatorHello()
      })
      .catch(() => undefined)

    return () => {
      gone = true
      stop?.()
    }
  }, [])

  return <WakeIndicatorLight state={state} />
}

/** Trust nothing off the event bus: any window of this app can emit, so the
 *  payload is checked against the three states rather than cast. */
function normalize(payload: unknown): null | WakeIndicatorState {
  return WAKE_INDICATOR_STATES.includes(payload as WakeIndicatorState) ? (payload as WakeIndicatorState) : null
}

/**
 * A transparent window needs a transparent document, and the app's stylesheet
 * paints `body` with the chat surface colour.
 *
 * The same rule Quick Entry carries for the same reason, kept with the surface
 * that needs it rather than added to the app-wide stylesheet.
 */
function useTransparentSurface(): void {
  useLayoutEffect(() => {
    const style = document.createElement('style')

    style.textContent = 'html,body,#root{background:transparent !important;}'
    document.head.appendChild(style)

    return () => style.remove()
  }, [])
}
