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

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { setSurfaceInteractiveRect, type SurfaceGrant } from '@/lib/surface'
import { resizeSatelliteWindow, satelliteSurfaceGrant } from '@/store/windows'

import { canUseHud, HUD_SURFACE } from './hud'
import { hudWindowHeight, hudWindowWidth } from './hud-size'

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

/** The bar, and the transcript's natural height. Both live inside `ChatScreen`,
 *  so they are found by slot rather than held as refs. */
const BAR_SELECTOR = "[data-slot='composer-root']"
const TRANSCRIPT_SELECTOR = "[data-slot='aui_thread-content']"

export interface HudCardMetrics {
  /** `--hud-band-max` in pixels, so growth and the CSS cap agree. */
  bandMaxPx: number
  /** Whether the composer attachment/context menu dropdown is currently open. */
  attachmentMenuOpen?: boolean
  /** Whether the composer model selector dropdown is currently open. */
  modelMenuOpen?: boolean
  /** Whether the response panel is showing. */
  open: boolean
  /** Whether the platform gave this surface the whole output. */
  outputSized: boolean
}

/**
 * One `ResizeObserver` over the HUD's card, doing the two things the card's size
 * decides — split by which surface the platform actually granted.
 *
 * **Output-sized (Wayland layer-shell).** The surface is already the size of the
 * screen, so nothing is resized: the card grows and shrinks by CSS alone, and
 * what has to follow it is the INPUT REGION. Everything outside the card must
 * pass clicks through or the HUD swallows every click on the desktop, and a
 * region that lags the card is a strip of screen that either eats clicks meant
 * for the app underneath or drops clicks meant for the HUD.
 *
 * **Card-sized (macOS / Windows / X11).** The window IS the card, so growth has
 * to be a real resize — `resizeSatelliteWindow`, which keeps the top edge fixed
 * so the HUD grows downward.
 *
 * WHAT IS MEASURED IS NOT THE CARD. On the card-sized path the card is `h-full`,
 * so its height is the window's height, and resizing the window to the card's
 * height is a fixed point that can never grow. The bar and the transcript's
 * content box are measured instead — neither is bounded by the window — and
 * `hudWindowHeight` turns them into a request, bucketed to 8px because a
 * streaming reply changes the content height a pixel at a time dozens of times a
 * second and each of those would be an IPC round trip for a change nobody can
 * see.
 */
export function useHudCardMetrics(cardRef: RefObject<HTMLElement | null>, metrics: HudCardMetrics): void {
  // Read through a ref rather than a dependency. The panel opening is a state
  // change on every summon and every collapse, and re-installing a
  // compositor-visible observer for a value the callback can simply read is
  // churn the surface layer would have to service.
  const latest = useRef(metrics)
  latest.current = metrics

  const frame = useRef(0)
  const lastRect = useRef('')
  const lastHeight = useRef(0)
  const lastWidth = useRef(0)
  const observer = useRef<null | ResizeObserver>(null)

  const measure = useCallback(() => {
    const card = cardRef.current

    if (!card) {
      return
    }

    const { attachmentMenuOpen, bandMaxPx, modelMenuOpen, open, outputSized } = latest.current

    if (outputSized) {
      const box = card.getBoundingClientRect()
      let height = Math.ceil(box.height)
      let width = Math.ceil(box.width)

      const menuNodes = document.querySelectorAll<HTMLElement>(
        "[data-slot='dropdown-menu-content'], [data-slot='dropdown-menu-sub-content']"
      )

      for (const menuNode of menuNodes) {
        const menuBox = menuNode.getBoundingClientRect()
        height = Math.max(height, Math.ceil(menuBox.bottom - box.top))
        width = Math.max(width, Math.ceil(menuBox.right - box.left))
      }

      const rect = {
        height,
        width,
        x: Math.floor(box.left),
        y: Math.floor(box.top)
      }

      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`

      // A no-op region write still crosses IPC and still asks the compositor to
      // re-evaluate the surface; the card is remeasured far more often than it
      // actually moves.
      if (key === lastRect.current || rect.width <= 0 || rect.height <= 0) {
        return
      }

      lastRect.current = key
      void setSurfaceInteractiveRect(HUD_LABEL, rect)

      return
    }

    const height = hudWindowHeight({
      attachmentMenuOpen,
      bandMaxPx,
      barPx: card.querySelector<HTMLElement>(BAR_SELECTOR)?.offsetHeight ?? 0,
      contentPx: card.querySelector<HTMLElement>(TRANSCRIPT_SELECTOR)?.offsetHeight ?? 0,
      modelMenuOpen,
      open
    })

    const width = hudWindowWidth({
      attachmentMenuOpen,
      modelMenuOpen
    })

    // Same reasoning as the region write above: an unchanged bucket still costs
    // a round trip and a compositor reconfigure.
    if (height === lastHeight.current && width === lastWidth.current) {
      return
    }

    lastHeight.current = height
    lastWidth.current = width
    void resizeSatelliteWindow(height, width)
  }, [cardRef])

  // Coalesced through one animation frame, so a burst of mutations inside a
  // single streamed chunk produces one measurement rather than one per node.
  const schedule = useCallback(() => {
    if (frame.current) {
      return
    }

    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      measure()
    })
  }, [measure])

  useEffect(() => {
    const instance = new ResizeObserver(schedule)

    observer.current = instance

    return () => {
      observer.current = null
      instance.disconnect()

      if (frame.current) {
        window.cancelAnimationFrame(frame.current)
        frame.current = 0
      }

      // Hand the whole surface back on the way out. Leaving a stale hole behind
      // would make a window that is closing anyway eat clicks while it does.
      // Unconditional: releasing a region that was never taken is a no-op.
      void setSurfaceInteractiveRect(HUD_LABEL, null)
    }
  }, [schedule])

  // Deliberately no dependency array. The bar and the transcript are found by
  // slot inside `ChatScreen`, and the transcript's content box is REPLACED when
  // the thread swaps between its empty placeholder and its message list — so an
  // observer bound once would keep watching a node that no longer exists and go
  // quiet at the exact moment the first reply arrives. Re-observing is cheap and
  // idempotent.
  useEffect(() => {
    const card = cardRef.current
    const instance = observer.current

    if (!card || !instance) {
      return
    }

    instance.disconnect()
    instance.observe(card)

    for (const selector of [BAR_SELECTOR, TRANSCRIPT_SELECTOR]) {
      const node = card.querySelector(selector)

      if (node) {
        instance.observe(node)
      }
    }

    schedule()
  })
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
