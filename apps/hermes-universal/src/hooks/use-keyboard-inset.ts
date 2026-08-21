import { useEffect, useState } from 'react'

// Soft-keyboard geometry, from the Visual Viewport API.
//
// The mobile webviews Tauri embeds do NOT reliably shrink the layout viewport
// when the on-screen keyboard opens — WKWebView overlays it on top of content,
// and Android's behaviour flips between launches — so `position: fixed` bottom
// bars end up UNDER the keyboard. `window.visualViewport` reports the actually-
// visible region.
//
// Two different numbers come out of that, and conflating them was a bug:
//   OCCLUSION — `innerHeight - visualViewport.height`. How much of the layout
//     viewport is not on screen. This is what "is the keyboard up" means.
//   LIFT — `occlusion - visualViewport.offsetTop`. How far a box anchored to the
//     LAYOUT viewport still has to rise to clear the keyboard, after the webview
//     has already scrolled the visible band down by `offsetTop`. This is what
//     `--keyboard-inset` publishes.
// WKWebView reveals a focused caret by scrolling the visual viewport, and the
// composer sits at the very bottom of the layout viewport — so `offsetTop` grows
// to nearly the whole keyboard and the LIFT collapses to ~0 while the keyboard
// is plainly up. Deriving open/closed from the lift therefore reported CLOSED on
// iOS every time the composer was focused, which left the home-indicator safe
// area padded against a strip the keyboard was covering: the phantom gap between
// the composer and the keyboard (`--composer-dock-inset-bottom`, styles.css).
//
// We publish that as `--keyboard-inset` on :root (so CSS can lift a docked bar
// with `margin-bottom: var(--keyboard-inset)`) and set `data-keyboard-open` on
// <html> for open/closed styling. NOTE: on some Tauri versions visualViewport
// does not track the keyboard at all (tauri #10631) — then the inset stays 0.
// The live readout in the mobile shell is how we tell which case we're on.
//
// The measurement lives in ONE module-level subscription rather than one per
// caller. Two shells mount this hook (the home shell and the surface shell) and
// both can be live at once; per-caller effects meant whichever unmounted first
// deleted `--keyboard-inset` out from under the survivor, which is how a lifted
// surface got stuck short until the next resize event happened to fire.

export interface KeyboardState {
  /** px the keyboard occludes at the bottom of the layout viewport. */
  inset: number
  /** `window.visualViewport.height` (visible viewport). */
  viewportHeight: number
  /** `window.innerHeight` (layout viewport). */
  innerHeight: number
  /** `window.visualViewport.offsetTop` (pinch-zoom / URL bar offset). */
  offsetTop: number
  /** Heuristic: the keyboard is up (inset past a small threshold). */
  open: boolean
}

// Small keyboards (accessory bars) vs a real keyboard: treat < 80px as "closed"
// so a URL bar or safe-area jitter doesn't read as an open keyboard.
const OPEN_THRESHOLD_PX = 80

// The keyboard animates in and out over ~200-300ms, and the webview fires resize
// events all the way through it. The last event in a burst is not reliably the
// settled geometry — on Android the close animation can end on a stale frame, and
// on some Tauri builds it can end on no event at all (tauri#10631) — so a focus
// change re-measures on its own schedule until the geometry stops moving.
const SETTLE_MS = [120, 300, 600, 1000] as const

const INITIAL: KeyboardState = { inset: 0, viewportHeight: 0, innerHeight: 0, offsetTop: 0, open: false }

type Listener = (state: KeyboardState) => void

const listeners = new Set<Listener>()
let current: KeyboardState = INITIAL
let teardown: (() => void) | null = null

function measure(): KeyboardState {
  const vv = window.visualViewport
  const innerHeight = window.innerHeight
  const viewportHeight = vv ? vv.height : innerHeight
  const offsetTop = vv ? vv.offsetTop : 0
  // How much of the layout viewport is off screen — scroll-independent, so a
  // webview that reveals the caret by scrolling the visual viewport cannot hide
  // an open keyboard from us. See the header.
  const occluded = Math.max(0, Math.round(innerHeight - viewportHeight))
  const raw = Math.max(0, Math.round(occluded - offsetTop))
  const open = occluded > OPEN_THRESHOLD_PX

  return {
    // The LIFT, not the occlusion — a layout-viewport-anchored box only has to
    // make up what the webview's own scroll did not. Published as 0 whenever the
    // keyboard reads as closed: sub-threshold residue is never a keyboard — it is
    // URL-bar or safe-area jitter — and letting it through means a surface that
    // lifted by `--keyboard-inset` comes back a few px short and stays there.
    inset: open ? raw : 0,
    innerHeight,
    offsetTop: Math.round(offsetTop),
    open,
    viewportHeight: Math.round(viewportHeight)
  }
}

function start(): () => void {
  const root = document.documentElement
  let settleTimers: ReturnType<typeof setTimeout>[] = []

  const clearSettle = () => {
    for (const timer of settleTimers) {
      clearTimeout(timer)
    }

    settleTimers = []
  }

  const publish = () => {
    current = measure()
    root.style.setProperty('--keyboard-inset', `${current.inset}px`)
    // The VISIBLE rectangle, published raw. A `position: fixed` surface sized
    // from these tracks the keyboard exactly, including the case that broke it:
    // a webview that reveals a focused input by SCROLLING the visual viewport
    // rather than resizing the layout one, which leaves a layout-viewport-sized
    // box at full height and carries it off the top of the screen.
    root.style.setProperty('--visual-viewport-height', `${current.viewportHeight}px`)
    root.style.setProperty('--visual-viewport-top', `${current.offsetTop}px`)
    root.toggleAttribute('data-keyboard-open', current.open)

    for (const listener of listeners) {
      listener(current)
    }
  }

  const update = () => {
    publish()
    clearSettle()
    // Re-measure across the whole animation rather than once after it: the
    // stream of resize events is not trustworthy on either end, and a geometry
    // that has already settled makes these writes no-ops.
    settleTimers = SETTLE_MS.map(ms => setTimeout(publish, ms))
  }

  const vv = window.visualViewport

  publish()

  vv?.addEventListener('resize', update)
  vv?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  // Focus is the one signal that always brackets a keyboard, including the cases
  // where the webview never fires a matching resize.
  window.addEventListener('focusin', update)
  window.addEventListener('focusout', update)

  return () => {
    clearSettle()
    vv?.removeEventListener('resize', update)
    vv?.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
    window.removeEventListener('focusin', update)
    window.removeEventListener('focusout', update)
    root.style.removeProperty('--keyboard-inset')
    root.style.removeProperty('--visual-viewport-height')
    root.style.removeProperty('--visual-viewport-top')
    root.removeAttribute('data-keyboard-open')
    current = INITIAL
  }
}

export function useKeyboardInset(): KeyboardState {
  const [state, setState] = useState<KeyboardState>(current)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    listeners.add(setState)

    if (!teardown) {
      teardown = start()
    }

    setState(current)

    return () => {
      listeners.delete(setState)

      // Only the last subscriber tears the measurement down; anything else would
      // strip `--keyboard-inset` while another shell is still lifting by it.
      if (listeners.size === 0 && teardown) {
        teardown()
        teardown = null
      }
    }
  }, [])

  return state
}
