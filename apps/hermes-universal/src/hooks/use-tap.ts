import { useRef } from 'react'

import { createTap } from '@/lib/touch'

/**
 * Rule 31, as props you can spread onto any element.
 *
 * On a touch screen `click` is not an event the page receives, it is a VERDICT
 * the engine reaches after ruling out a scroll and a drag — and the Android
 * WebView routinely rules against a quick jab on a row inside a scrollable
 * list. `createTap` reads `pointerup` directly and takes the engine out of the
 * decision; the capture-phase guard then kills the synthetic click if one does
 * arrive, so a gesture can never both tap and click. A mouse never arms the
 * gesture (`createTap` ignores `pointerType === 'mouse'`) and its native click
 * path is untouched.
 *
 * The gesture object is created once and reads the LATEST handler through a
 * ref, so a caller that rebuilds its callback every render — which is every
 * caller — does not tear out a press that is mid-flight.
 *
 * Extracted from the copy `app/shell/downloads-tray.tsx` and
 * `app/right-pane/files/tree.tsx` each grew for themselves; those two are
 * welded into their own row semantics, this is the plain case.
 */
export function useTapHandlers(onTap: () => void): {
  onClick: () => void
  onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => void
  onPointerCancel: () => void
  onPointerDown: (point: { clientX: number; clientY: number; pointerType: string }) => void
  onPointerMove: (point: { clientX: number; clientY: number; pointerType: string }) => void
  onPointerUp: (point: { clientX: number; clientY: number; pointerType: string }) => boolean
} {
  const handlerRef = useRef(onTap)
  const tapRef = useRef<null | ReturnType<typeof createTap>>(null)

  handlerRef.current = onTap

  if (!tapRef.current) {
    tapRef.current = createTap({ onTap: () => handlerRef.current() })
  }

  const tap = tapRef.current

  return {
    onClick: () => handlerRef.current(),
    onClickCapture: event => {
      if (tap.fired()) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    onPointerCancel: tap.cancel,
    onPointerDown: tap.down,
    onPointerMove: tap.move,
    onPointerUp: tap.up
  }
}
