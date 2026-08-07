// Long-press detection, decoupled from the DOM.
//
// A long press is the touch stand-in for right-click, and it is always in
// tension with whatever else the same finger could be starting: a pan, a drag,
// a scroll. So the detector needs BOTH a timer and a movement tolerance —
// without the tolerance every pan that begins slowly fires a menu, and the two
// hand-rolled copies already in this app disagree about that (profile-switcher
// waits 450ms with no tolerance and leans on dnd to cancel it; use-popout-drag
// waits 360ms and cancels past 10px). This is the shared version those should
// eventually collapse into.
//
// It takes plain coordinates rather than events so it can be unit-tested with
// fake timers and reused from a canvas, a pointer handler, or a synthetic
// gesture. The caller owns pointer capture and haptics.

export const LONG_PRESS_MS = 500
/** Slop before a press is re-read as a drag. 10px matches use-popout-drag; a
 *  finger wobbles several px just resting, so anything tighter misfires. */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

export interface LongPressOptions {
  /** Hold duration before `onFire`. */
  ms?: number
  /** Movement past this distance from the press origin cancels the press. */
  moveTolerancePx?: number
  /** Called once per press, on the timer, if it was never cancelled. */
  onFire: (origin: { x: number; y: number }) => void
}

export interface LongPress {
  /** Arm a press at the press origin. Re-arms if one was already pending. */
  down: (x: number, y: number) => void
  /** Feed pointer movement; cancels if it leaves the tolerance radius. */
  move: (x: number, y: number) => void
  /** Pointer released — cancels a press that has not fired yet. */
  up: () => void
  /** Cancel for any other reason (pointercancel, unmount, a drag winning). */
  cancel: () => void
  /** True between `down` and the press firing or being cancelled. */
  pending: () => boolean
  /** True once `onFire` has run, until the next `down`. Lets a caller suppress
   *  the trailing tap/click that the same gesture would otherwise produce. */
  fired: () => boolean
}

export function createLongPress({
  ms = LONG_PRESS_MS,
  moveTolerancePx = LONG_PRESS_MOVE_TOLERANCE_PX,
  onFire
}: LongPressOptions): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null
  let origin: { x: number; y: number } | null = null
  let didFire = false

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }

    origin = null
  }

  return {
    down(x, y) {
      clear()
      didFire = false
      origin = { x, y }
      timer = setTimeout(() => {
        const at = origin

        timer = null
        origin = null

        if (at) {
          didFire = true
          onFire(at)
        }
      }, ms)
    },

    move(x, y) {
      if (!origin) {
        return
      }

      const dx = x - origin.x
      const dy = y - origin.y

      // Squared compare — the tolerance is a radius, and this runs per move.
      if (dx * dx + dy * dy > moveTolerancePx * moveTolerancePx) {
        clear()
      }
    },

    up() {
      clear()
    },

    cancel() {
      clear()
      didFire = false
    },

    pending() {
      return timer !== null
    },

    fired() {
      return didFire
    }
  }
}
