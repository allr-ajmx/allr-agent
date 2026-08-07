import { useEffect, useState } from 'react'

// Soft-keyboard geometry, from the Visual Viewport API.
//
// The mobile webviews Tauri embeds do NOT reliably shrink the layout viewport
// when the on-screen keyboard opens — WKWebView overlays it on top of content,
// and Android's behaviour flips between launches — so `position: fixed` bottom
// bars end up UNDER the keyboard. `window.visualViewport` reports the actually-
// visible region, so the height the keyboard occludes is
// `innerHeight - visualViewport.height - visualViewport.offsetTop`.
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
// settled geometry — on Android the close animation can end on a stale frame —
// so every burst schedules one more measurement after it should be over.
const SETTLE_MS = 300

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
  const raw = Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop))
  const open = raw > OPEN_THRESHOLD_PX

  return {
    // Publish 0 whenever the keyboard reads as closed. Sub-threshold residue is
    // never a keyboard — it is URL-bar or safe-area jitter — and letting it
    // through means a surface that lifted by `--keyboard-inset` comes back a few
    // px short and stays there.
    inset: open ? raw : 0,
    innerHeight,
    offsetTop: Math.round(offsetTop),
    open,
    viewportHeight: Math.round(viewportHeight)
  }
}

function start(): () => void {
  const root = document.documentElement
  let settleTimer: null | ReturnType<typeof setTimeout> = null

  const publish = () => {
    current = measure()
    root.style.setProperty('--keyboard-inset', `${current.inset}px`)
    root.toggleAttribute('data-keyboard-open', current.open)

    for (const listener of listeners) {
      listener(current)
    }
  }

  const update = () => {
    publish()

    if (settleTimer !== null) {
      clearTimeout(settleTimer)
    }

    settleTimer = setTimeout(publish, SETTLE_MS)
  }

  const vv = window.visualViewport

  publish()

  vv?.addEventListener('resize', update)
  vv?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  // Blur is the one signal that always precedes a keyboard close, including the
  // cases where the webview never fires a matching resize.
  window.addEventListener('focusin', update)
  window.addEventListener('focusout', update)

  return () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
    }

    vv?.removeEventListener('resize', update)
    vv?.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
    window.removeEventListener('focusin', update)
    window.removeEventListener('focusout', update)
    root.style.removeProperty('--keyboard-inset')
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
