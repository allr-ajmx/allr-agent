import type * as React from 'react'

/** `MouseEvent.button` for the middle (wheel) button. */
const MIDDLE_BUTTON = 1

/** ⌘-click (metaKey + primary button) — the Mac has no middle button, so this
 *  is the trackpad equivalent of middle-click-to-close. Guarded on metaKey so
 *  it never collides with left-click (activate/drag) or ⌃-click (macOS context
 *  menu). */
export const isMetaClose = (event: { button: number; metaKey: boolean }): boolean => event.button === 0 && event.metaKey

/** Where the current middle press started. One pointer holds one button, so a
 *  single slot is the whole state. */
let pressedOn: EventTarget | null = null

/**
 * Every gesture starts disarmed.
 *
 * The slot used to be cleared only by the handlers themselves, on the theory
 * that "a value left behind by a press released elsewhere is inert". It is not.
 * Press a tab, slide off it and let go over something that owns no gesture, and
 * the slot still names that tab — the release never reached a handler that could
 * clear it. The NEXT middle press that also starts off-gesture (the gaps between
 * tabs, the terminal rail's list, the sidebar's empty space) leaves the stale
 * value in place, so its release over that same tab reads as ARMED and closes
 * it. That is the press-here-release-there misfire the same-element rule exists
 * to prevent, run backwards — and on the terminal rail it kills a live shell
 * with no prompt.
 *
 * So the slot is cleared by the DOM rather than by the handlers: a capture-phase
 * listener on `window` runs ahead of every element's own pointerdown, so only an
 * element that owns the gesture can re-arm it. `pointercancel` clears it too — a
 * press the browser hands to a scroll or a drag is not a click. Both also drop
 * the slot's reference to a tab element that has since left the DOM.
 *
 * Registered by the factory rather than at module scope, so merely importing the
 * module (SSR, a tree-shaken type import) touches no globals.
 */
const disarm = (): void => {
  pressedOn = null
}

let listening = false

function watchForNewGestures(): void {
  if (listening || typeof window === 'undefined') {
    return
  }

  listening = true
  window.addEventListener('pointerdown', disarm, true)
  window.addEventListener('pointercancel', disarm, true)
}

/**
 * Middle-click as a gesture that survives a real three-button mouse.
 *
 * `auxclick` is the obvious event and the wrong one to build on. Windows and
 * Linux answer a middle press inside a scroller by starting the AUTOSCROLL pan,
 * and the mouseup that ends the pan is spent stopping it instead of completing a
 * click — so `auxclick` never arrives. Every surface carrying this gesture (tab
 * strips, the session list, the terminal rail) is a scroller, which is why it
 * only ever worked on macOS, where autoscroll does not exist.
 *
 * Pointer events fire either way, so the gesture arms on pointerdown and is
 * spent on the pointerup over the SAME element — press one tab, release on
 * another and nothing happens (Chrome / VS Code semantics). mousedown's default
 * dies on every middle press, action or not, so the pan widget cannot appear on
 * a surface that owns the button.
 *
 * A plain factory, not a hook: tab strips call it inside `map()`.
 */
export function middleClickHandlers(action: (() => void) | undefined) {
  watchForNewGestures()

  return {
    onMouseDown: (event: React.MouseEvent) => {
      if (event.button === MIDDLE_BUTTON) {
        event.preventDefault()
      }
    },

    onPointerDown: (event: React.PointerEvent) => {
      if (event.button === MIDDLE_BUTTON) {
        pressedOn = action ? event.currentTarget : null
      }
    },

    onPointerUp: (event: React.PointerEvent) => {
      if (event.button !== MIDDLE_BUTTON) {
        return
      }

      const armed = pressedOn === event.currentTarget
      pressedOn = null

      if (armed) {
        action?.()
      }
    }
  }
}
