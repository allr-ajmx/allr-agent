// The touch profile: the numbers every gesture in this app should agree on, and
// a tap detector that does not go through the browser's `click`.
//
// Why a tap detector at all. On a touch screen a `click` is not an event the
// page receives, it is a VERDICT the engine reaches after deciding the gesture
// was not a scroll and not a drag. On the Android WebView that verdict is
// contested for a row inside a scrollable virtualized list, and a quick jab
// loses it — the file tree spent four rounds moving its `onClick` between
// nested divs before the handler placement was ruled out as the cause. Reading
// `pointerup` ourselves removes the engine from the decision: a release that
// stayed inside the slop radius and under the time cap IS a tap.
//
// Mouse is deliberately excluded. A fine pointer's native click is reliable,
// carries modifier keys and double-click, and desktop behaviour must not move.
//
// Coordinates in, no DOM out — same contract as lib/long-press.ts, so this
// unit-tests with plain numbers and fake timers.

import { matchesQuery } from '@/hooks/use-media-query'

import { LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_MS } from './long-press'

export { LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_MS }

/** Is the primary pointer a finger? Read LIVE, at the moment of the gesture —
 *  `lib/platform.ts`'s flags are consts frozen at first import (and deliberately
 *  refuse to tag a touchscreen laptop as mobile), so they are the wrong question
 *  for "how is this being touched right now". */
export const isCoarsePointer = (): boolean => matchesQuery('(pointer: coarse)')

/** Movement allowed before a press stops being a tap. Shares the long-press
 *  tolerance on purpose: it is the same physical fact (a resting finger wobbles
 *  several px), so the two must never disagree. */
export const TAP_SLOP_PX = LONG_PRESS_MOVE_TOLERANCE_PX

/** Past this a press is a press, not a tap. Sized above `LONG_PRESS_MS` so a
 *  surface that also long-presses resolves to the press, never to both. */
export const TAP_MAX_MS = 700

/** Slop before a pointer drag engages. A mouse is precise and a drag is the
 *  point of the gesture; a finger is not, and on a list the competing gesture
 *  is a scroll the user very much wants — so touch gets more room than the
 *  tap slop, not less, or every scroll becomes a drag. */
export const MOUSE_DRAG_SLOP_PX = 4
export const TOUCH_DRAG_SLOP_PX = 12

export function dragSlopPx(pointerType: string): number {
  return pointerType === 'mouse' ? MOUSE_DRAG_SLOP_PX : TOUCH_DRAG_SLOP_PX
}

/** The bits of a PointerEvent a tap is decided from. */
export interface TapPoint {
  clientX: number
  clientY: number
  pointerType: string
}

export interface TapOptions {
  /** Longest press still counted as a tap. */
  maxMs?: number
  /** Called on a qualifying release. */
  onTap: (point: TapPoint) => void
  /** Movement past this distance from the press origin disqualifies the tap. */
  slopPx?: number
}

export interface Tap {
  /** Abandon the press (pointercancel, unmount, another gesture winning). */
  cancel: () => void
  /** Arm a press. A mouse pointer is ignored — its native click still rules. */
  down: (point: TapPoint) => void
  /** True from a firing `up` until the next `down`. Lets the caller swallow the
   *  synthetic click the same gesture may still produce. */
  fired: () => boolean
  /** Feed movement; leaving the slop radius disqualifies the press. */
  move: (point: TapPoint) => void
  /** Release. Returns true (and calls `onTap`) if this was a tap. */
  up: (point: TapPoint) => boolean
}

export function createTap({ maxMs = TAP_MAX_MS, onTap, slopPx = TAP_SLOP_PX }: TapOptions): Tap {
  let origin: { at: number; x: number; y: number } | null = null
  let didFire = false

  const beyondSlop = (point: TapPoint, from: { x: number; y: number }): boolean => {
    const dx = point.clientX - from.x
    const dy = point.clientY - from.y

    // Squared compare — the tolerance is a radius, and `move` runs per frame.
    return dx * dx + dy * dy > slopPx * slopPx
  }

  return {
    cancel() {
      origin = null
      didFire = false
    },

    down(point) {
      didFire = false
      origin = point.pointerType === 'mouse' ? null : { at: Date.now(), x: point.clientX, y: point.clientY }
    },

    fired() {
      return didFire
    },

    move(point) {
      if (origin && beyondSlop(point, origin)) {
        origin = null
      }
    },

    up(point) {
      const start = origin

      origin = null

      if (!start || beyondSlop(point, start) || Date.now() - start.at > maxMs) {
        return false
      }

      didFire = true
      onTap(point)

      return true
    }
  }
}
