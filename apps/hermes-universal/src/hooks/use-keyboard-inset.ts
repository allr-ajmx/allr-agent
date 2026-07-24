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

const INITIAL: KeyboardState = { inset: 0, viewportHeight: 0, innerHeight: 0, offsetTop: 0, open: false }

export function useKeyboardInset(): KeyboardState {
  const [state, setState] = useState<KeyboardState>(INITIAL)

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const vv = window.visualViewport
    const root = document.documentElement

    const update = () => {
      const innerHeight = window.innerHeight
      const viewportHeight = vv ? vv.height : innerHeight
      const offsetTop = vv ? vv.offsetTop : 0
      const inset = Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop))
      const open = inset > OPEN_THRESHOLD_PX

      root.style.setProperty('--keyboard-inset', `${inset}px`)
      root.toggleAttribute('data-keyboard-open', open)

      setState({ inset, viewportHeight: Math.round(viewportHeight), innerHeight, offsetTop: Math.round(offsetTop), open })
    }

    update()

    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)

    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      root.style.removeProperty('--keyboard-inset')
      root.removeAttribute('data-keyboard-open')
    }
  }, [])

  return state
}
