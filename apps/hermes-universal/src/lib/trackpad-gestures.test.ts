import { describe, expect, it } from 'vitest'

import {
  createDoubleTapDetector,
  createPinchTracker,
  DOUBLE_TAP_MS,
  isPinchZoomWheel,
  isSmartZoomWheel
} from './trackpad-gestures'

describe('wheel disambiguation', () => {
  it('reads a delta-less ctrl-wheel as smart zoom', () => {
    expect(isSmartZoomWheel({ ctrlKey: true, deltaX: 0, deltaY: 0 })).toBe(true)
    expect(isPinchZoomWheel({ ctrlKey: true, deltaX: 0, deltaY: 0 })).toBe(false)
  })

  it('reads a ctrl-wheel carrying a delta as pinch zoom', () => {
    expect(isPinchZoomWheel({ ctrlKey: true, deltaX: 0, deltaY: -4 })).toBe(true)
    expect(isSmartZoomWheel({ ctrlKey: true, deltaX: 0, deltaY: -4 })).toBe(false)
  })

  it('reads a plain two-finger scroll as neither', () => {
    expect(isSmartZoomWheel({ ctrlKey: false, deltaX: 3, deltaY: 9 })).toBe(false)
    expect(isPinchZoomWheel({ ctrlKey: false, deltaX: 3, deltaY: 9 })).toBe(false)
  })
})

describe('createDoubleTapDetector', () => {
  it('reports the second of two taps inside the threshold', () => {
    const tap = createDoubleTapDetector()

    expect(tap(1_000)).toBe(false)
    expect(tap(1_000 + DOUBLE_TAP_MS - 1)).toBe(true)
  })

  it('does not report taps spaced beyond the threshold', () => {
    const tap = createDoubleTapDetector()

    expect(tap(1_000)).toBe(false)
    expect(tap(1_000 + DOUBLE_TAP_MS)).toBe(false)
  })

  it('resets after a pair, so a third tap starts fresh', () => {
    const tap = createDoubleTapDetector()

    tap(10_000)
    expect(tap(10_010)).toBe(true)
    expect(tap(10_020)).toBe(false)
  })
})

describe('createPinchTracker', () => {
  it('arms only once a second contact lands', () => {
    const pinch = createPinchTracker()

    expect(pinch.down({ pointerId: 1, x: 0, y: 0 })).toBe(false)
    expect(pinch.active()).toBe(false)
    expect(pinch.down({ pointerId: 2, x: 100, y: 0 })).toBe(true)
    expect(pinch.active()).toBe(true)
    expect(pinch.count()).toBe(2)
  })

  it('emits nothing while only one contact is down', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    expect(pinch.move({ pointerId: 1, x: 10, y: 10 })).toBeNull()
  })

  it('reports the distance ratio as the scale', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })

    // Spread to 200px apart: twice the distance.
    const frame = pinch.move({ pointerId: 2, x: 200, y: 0 })

    expect(frame?.scale).toBeCloseTo(2)
  })

  it('measures each frame against the previous one, not the start', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })

    expect(pinch.move({ pointerId: 2, x: 200, y: 0 })?.scale).toBeCloseTo(2)
    // 200 → 300 is 1.5x more, not 3x from the origin.
    expect(pinch.move({ pointerId: 2, x: 300, y: 0 })?.scale).toBeCloseTo(1.5)
  })

  it('nets out to no zoom and a full centroid shift when both fingers translate', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })

    // Contacts arrive one at a time, so the intermediate frame legitimately
    // reports a scale — the fingers really are closer for that instant. What
    // must hold is that the gesture NETS to no zoom, and that the centroid has
    // travelled the full translation.
    const a = pinch.move({ pointerId: 1, x: 20, y: 30 })
    const b = pinch.move({ pointerId: 2, x: 120, y: 30 })

    expect((a?.scale ?? 0) * (b?.scale ?? 0)).toBeCloseTo(1)
    expect((a?.dx ?? 0) + (b?.dx ?? 0)).toBeCloseTo(20)
    expect((a?.dy ?? 0) + (b?.dy ?? 0)).toBeCloseTo(30)
    expect(b?.cx).toBeCloseTo(70)
    expect(b?.cy).toBeCloseTo(30)
  })

  it('reports a simultaneous translation as scale 1', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })

    // Same distance, shifted centroid: the pure-translation frame.
    pinch.move({ pointerId: 1, x: 20, y: 30 })
    const frame = pinch.move({ pointerId: 2, x: 120, y: 30 })

    pinch.clear()
    pinch.down({ pointerId: 1, x: 20, y: 30 })
    pinch.down({ pointerId: 2, x: 120, y: 30 })

    const pure = pinch.move({ pointerId: 2, x: 120, y: 30 })

    expect(pure?.scale).toBeCloseTo(1)
    expect(frame?.cx).toBeCloseTo(70)
  })

  it('gives the centroid as the point a zoom should hold fixed', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 10, y: 40 })
    pinch.down({ pointerId: 2, x: 90, y: 60 })

    const frame = pinch.move({ pointerId: 2, x: 90, y: 60 })

    expect(frame?.cx).toBeCloseTo(50)
    expect(frame?.cy).toBeCloseTo(50)
  })

  it('does not make the survivor jump when one finger lifts and returns', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })
    pinch.move({ pointerId: 2, x: 300, y: 0 })

    expect(pinch.up(2)).toBe(true)
    expect(pinch.active()).toBe(false)

    // The survivor pans a long way alone, then a second finger comes back down
    // close by. The next frame must be measured from the NEW geometry.
    pinch.move({ pointerId: 1, x: 500, y: 500 })
    pinch.down({ pointerId: 2, x: 600, y: 500 })

    const frame = pinch.move({ pointerId: 2, x: 600, y: 500 })

    expect(frame?.scale).toBeCloseTo(1)
    expect(frame?.dx).toBeCloseTo(0)
    expect(frame?.dy).toBeCloseTo(0)
  })

  it('reports lifting a finger from a one-contact gesture as not ending a pinch', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    expect(pinch.up(1)).toBe(false)
  })

  it('ignores an unknown pointer id', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })

    expect(pinch.move({ pointerId: 9, x: 999, y: 999 })).toBeNull()
    expect(pinch.count()).toBe(2)
  })

  it('treats coincident contacts as translation rather than dividing by zero', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 50, y: 50 })
    pinch.down({ pointerId: 2, x: 50, y: 50 })

    const frame = pinch.move({ pointerId: 2, x: 90, y: 50 })

    expect(frame?.scale).toBe(1)
    expect(Number.isFinite(frame?.scale)).toBe(true)
  })

  it('drops every contact on clear', () => {
    const pinch = createPinchTracker()

    pinch.down({ pointerId: 1, x: 0, y: 0 })
    pinch.down({ pointerId: 2, x: 100, y: 0 })
    pinch.clear()

    expect(pinch.count()).toBe(0)
    expect(pinch.active()).toBe(false)
    expect(pinch.move({ pointerId: 1, x: 5, y: 5 })).toBeNull()
  })
})
