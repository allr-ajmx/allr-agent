// Trackpad / pointer gesture primitives shared across canvas + DOM surfaces.
//
// macOS quirk (Chromium/WebKit): both pinch-zoom and "smart zoom" arrive as
// `wheel` events with `ctrlKey` synthetically set — there is no dedicated DOM
// event for either. They're disambiguated by their deltas:
//   - pinch-to-zoom: ctrlKey + a non-zero delta
//   - smart zoom:    ctrlKey + zero deltas   (the two-finger double-tap)
// Plain two-finger scroll has ctrlKey === false. Centralising this here keeps
// every zoom/pan surface from re-deriving the same OS trivia (and getting it
// wrong, which makes smart-zoom read as a zoom-in).

export interface WheelLike {
  ctrlKey: boolean
  deltaX: number
  deltaY: number
}

/** macOS "smart zoom" (two-finger double-tap): a ctrl-wheel with no delta. */
export function isSmartZoomWheel(e: WheelLike): boolean {
  return e.ctrlKey && e.deltaX === 0 && e.deltaY === 0
}

/** Pinch-to-zoom (or ctrl + mouse wheel): a ctrl-wheel carrying a delta. */
export function isPinchZoomWheel(e: WheelLike): boolean {
  return e.ctrlKey && (e.deltaX !== 0 || e.deltaY !== 0)
}

/** A tracked pointer contact. Coordinates are in whatever space the caller
 *  works in — the tracker only ever takes differences. */
export interface PinchPoint {
  pointerId: number
  x: number
  y: number
}

/** What a two-finger frame did. `scale` is INCREMENTAL (this frame relative to
 *  the last), which is the same shape a wheel step has, so a consumer can reuse
 *  its existing `k * step` clamp instead of snapshotting a base viewport. */
export interface PinchFrame {
  /** Distance ratio since the previous move. 1 = pure translation. */
  scale: number
  /** Centroid, in the caller's space — the point the zoom should hold fixed. */
  cx: number
  cy: number
  /** Centroid translation since the previous move, so two-finger pan works
   *  during a pinch (which is what people actually do). */
  dx: number
  dy: number
}

export interface PinchTracker {
  /** Register a contact. Returns true once two are down (the pinch armed). */
  down: (p: PinchPoint) => boolean
  /** Update a contact. Returns a frame only while two are down. */
  move: (p: PinchPoint) => PinchFrame | null
  /** Release a contact. Returns true if this ended an armed pinch. */
  up: (pointerId: number) => boolean
  /** Drop every contact (pointercancel, unmount). */
  clear: () => void
  active: () => boolean
  count: () => number
}

/**
 * Two-pointer pinch/zoom tracking for touch. macOS reports trackpad pinch as a
 * ctrl-wheel (see `isPinchZoomWheel`), but on a real touchscreen there is no
 * such shortcut — the gesture has to be derived from the raw contacts, which is
 * what this does.
 *
 * Deliberately pure and DOM-free: it takes ids and coordinates, keeps no
 * element references, and never touches the event. The caller owns pointer
 * capture and decides what `scale` means.
 */
export function createPinchTracker(): PinchTracker {
  const points = new Map<number, { x: number; y: number }>()
  // Last two-contact geometry, so each frame is measured against the previous
  // one rather than against the gesture's start.
  let lastDist = 0
  let lastCx = 0
  let lastCy = 0

  /** Re-seed the reference geometry from the current contacts. Called whenever
   *  the contact SET changes — the moment a finger joins or leaves, the old
   *  distance/centroid describe a different gesture, and using them would emit
   *  one enormous bogus frame (the visible symptom: the map jumps). */
  const reseed = (): void => {
    const [a, b] = [...points.values()]

    if (!a || !b) {
      lastDist = 0

      return
    }

    lastDist = Math.hypot(b.x - a.x, b.y - a.y)
    lastCx = (a.x + b.x) / 2
    lastCy = (a.y + b.y) / 2
  }

  return {
    down(p) {
      points.set(p.pointerId, { x: p.x, y: p.y })
      reseed()

      return points.size === 2
    },

    move(p) {
      if (!points.has(p.pointerId)) {
        return null
      }

      points.set(p.pointerId, { x: p.x, y: p.y })

      if (points.size !== 2) {
        return null
      }

      const [a, b] = [...points.values()]

      if (!a || !b) {
        return null
      }

      const dist = Math.hypot(b.x - a.x, b.y - a.y)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      // A zero previous distance means the fingers were coincident; treat it as
      // pure translation rather than dividing by zero into Infinity.
      const scale = lastDist > 0 && dist > 0 ? dist / lastDist : 1
      const frame: PinchFrame = { cx, cy, dx: cx - lastCx, dy: cy - lastCy, scale }

      lastDist = dist
      lastCx = cx
      lastCy = cy

      return frame
    },

    up(pointerId) {
      const wasActive = points.size === 2
      const had = points.delete(pointerId)

      reseed()

      return had && wasActive
    },

    clear() {
      points.clear()
      lastDist = 0
    },

    active() {
      return points.size === 2
    },

    count() {
      return points.size
    }
  }
}

export const DOUBLE_TAP_MS = 300

/**
 * Stateful double-tap detector for surfaces where a real `dblclick` may never
 * fire (e.g. a trackpad with tap-to-click off). Call it once per discrete tap;
 * it returns true when two taps land within `thresholdMs` of each other, then
 * resets so a third tap starts a fresh pair.
 */
export function createDoubleTapDetector(thresholdMs: number = DOUBLE_TAP_MS): (now?: number) => boolean {
  let last = 0

  return (now: number = Date.now()): boolean => {
    if (now - last < thresholdMs) {
      last = 0

      return true
    }

    last = now

    return false
  }
}
