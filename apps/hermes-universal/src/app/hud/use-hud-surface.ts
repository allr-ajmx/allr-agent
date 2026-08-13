/**
 * The HUD's side of the native surface contract (MJXHRM-213).
 *
 * Two things have to cross from the capability layer into React:
 *
 * 1. **What we were granted.** Attaching a floating surface is a one-shot that
 *    happens before this window's JS exists, so the HUD cannot ask; the window
 *    that summoned it writes the grant down and this reads it back. It matters
 *    because the two backends produce genuinely different layouts — a
 *    layer-shell surface covers the whole output and positions its own card, an
 *    ordinary window is card-sized and fills itself.
 *
 * 2. **Where the card is.** On an output-sized surface everything outside the
 *    card must be click-through, or the HUD would swallow every click on the
 *    screen. That is an input region, and only this side knows the rectangle.
 *
 * A third crossing belongs to the SUMMONING window rather than the HUD itself —
 * whether to offer the affordance at all — and lives here because it is the same
 * capability layer, reached the same way. See [`useCanUseHud`].
 */

import { type RefObject, useEffect, useState } from 'react'

import { setSurfaceInteractiveRect, type SurfaceGrant } from '@/lib/surface'
import { satelliteSurfaceGrant } from '@/store/windows'

import { canUseHud, HUD_SURFACE } from './hud'

/** The window label the native side knows this surface by. Must match
 *  `satelliteLabel()` in `store/windows.ts`. */
const HUD_LABEL = `sat-${HUD_SURFACE}`

/**
 * What the platform granted this surface, or null when it is an ordinary window
 * (no floating request, or a request the platform could not meet). Read once —
 * a grant cannot change while the window is up.
 */
export function useHudGrant(): null | SurfaceGrant {
  const [grant] = useState(() => satelliteSurfaceGrant(HUD_SURFACE))

  return grant
}

/**
 * Whether to OFFER the HUD here — `lib/surface.ts`'s rule for callers, in the
 * shape a component can use.
 *
 * Starts false and turns true once the capability query answers, rather than the
 * other way round: a button that appears a frame late is a detail, a button that
 * appears and then vanishes reads as a bug. The query is cached for the process,
 * so this costs one IPC round trip for the whole session.
 *
 * This is the affordance half of the gate. The enforcement half is in `openHud`,
 * because a hotkey does not go past a hidden button.
 */
export function useCanUseHud(): boolean {
  const [can, setCan] = useState(false)

  useEffect(() => {
    let live = true

    void canUseHud().then(ok => {
      if (live) {
        setCan(ok)
      }
    })

    return () => {
      live = false
    }
  }, [])

  return can
}

/**
 * Keep the surface's interactive region on the card.
 *
 * Only meaningful when the surface is output-sized: a card-sized window is
 * interactive everywhere by definition, and asking for a region there would be
 * asking the capability layer to cut a hole in something with no margin around
 * it.
 *
 * Measured with a `ResizeObserver` rather than on render, because the card's
 * height is driven by the chat band growing and shrinking, and a region that
 * lags the card is a strip of screen that either eats clicks meant for the app
 * underneath or drops clicks meant for the HUD.
 */
export function useHudInteractiveRect(cardRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const card = cardRef.current

    if (!enabled || !card) {
      return undefined
    }

    let last = ''

    const report = () => {
      const box = card.getBoundingClientRect()

      const rect = {
        height: Math.ceil(box.height),
        width: Math.ceil(box.width),
        x: Math.floor(box.left),
        y: Math.floor(box.top)
      }

      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`

      // A no-op region write still crosses IPC and still asks the compositor to
      // re-evaluate the surface; the card is remeasured far more often than it
      // actually moves.
      if (key === last || rect.width <= 0 || rect.height <= 0) {
        return
      }

      last = key
      void setSurfaceInteractiveRect(HUD_LABEL, rect)
    }

    const observer = new ResizeObserver(report)

    observer.observe(card)
    report()

    return () => {
      observer.disconnect()
      // Hand the whole surface back on the way out. Leaving a stale hole behind
      // would make a window that is closing anyway eat clicks while it does.
      void setSurfaceInteractiveRect(HUD_LABEL, null)
    }
  }, [cardRef, enabled])
}

/**
 * A transparent surface needs a transparent document, and the app's stylesheet
 * paints `body` with the chat surface colour. Flag the root so the HUD-only
 * rules in `styles.css` can undo that for this window and nothing else.
 */
export function useTransparentDocument(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    document.documentElement.dataset.hud = ''

    return () => {
      delete document.documentElement.dataset.hud
    }
  }, [enabled])
}
