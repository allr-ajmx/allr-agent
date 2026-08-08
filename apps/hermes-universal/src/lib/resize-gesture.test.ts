import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $calmDuringResize,
  $resizeThrottle,
  beginResizeGesture,
  endResizeGesture,
  RESIZE_THROTTLE_MS,
  resizeGestureActive,
  resizeThrottleHz,
  resizeThrottleMs,
  throttleDuringResize
} from './resize-gesture'

const BALANCED = RESIZE_THROTTLE_MS.balanced

beforeEach(() => {
  vi.useFakeTimers()
  $resizeThrottle.set('balanced')
  $calmDuringResize.set(false)
})

afterEach(() => {
  // Never leave a gesture open — the depth counter is module state.
  while (resizeGestureActive()) {
    endResizeGesture()
  }

  vi.useRealTimers()
  delete document.documentElement.dataset.resizing
})

describe('throttleDuringResize', () => {
  it('is a pass-through when no gesture is running', () => {
    const fn = vi.fn()
    const throttled = throttleDuringResize('chat', fn)

    throttled()
    throttled()
    throttled()

    // Mount measurement, session switches and a growing composer all land here;
    // if this ever batches, those paths silently regress.
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('is a pass-through at preset "off", gesture or not', () => {
    $resizeThrottle.set('off')

    const fn = vi.fn()
    const throttled = throttleDuringResize('chat', fn)

    beginResizeGesture()
    throttled()
    throttled()
    throttled()

    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('runs the leading call immediately, then at most one per interval', () => {
    const fn = vi.fn()
    const throttled = throttleDuringResize('chat', fn)

    beginResizeGesture()

    // The first move of a drag has to land now, or a short drag never tracks.
    throttled('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('a')

    // A frame's worth of moves inside the window collapse into one trailing call
    // carrying the LAST value — dropping the intermediates is the whole point.
    throttled('b')
    throttled('c')
    throttled('d')
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BALANCED)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('d')
  })

  it('flushes the pending call when the gesture ends mid-window', () => {
    const fn = vi.fn()
    const throttled = throttleDuringResize('chat', fn)

    beginResizeGesture()
    throttled('first')
    throttled('final')

    expect(fn).toHaveBeenCalledTimes(1)

    // Releasing before the window elapses must still commit the final geometry,
    // or the pane keeps whatever it measured at the leading edge.
    endResizeGesture()

    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith('final')
  })

  it('reads the rate per call, so a preset change applies without a remount', () => {
    const fn = vi.fn()
    const throttled = throttleDuringResize('chat', fn)

    beginResizeGesture()
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)

    // The settings toggle must reach a handler wrapped long before it — the
    // interval cannot be captured at wrap time.
    $resizeThrottle.set('off')
    throttled()
    throttled()

    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('gesture nesting', () => {
  it('stays active until the last overlapping gesture ends', () => {
    const onEnd = vi.fn()
    const throttled = throttleDuringResize('chat', onEnd)

    beginResizeGesture()
    beginResizeGesture()
    expect(resizeGestureActive()).toBe(true)

    endResizeGesture()
    expect(resizeGestureActive()).toBe(true)

    endResizeGesture()
    expect(resizeGestureActive()).toBe(false)

    // And the throttle follows the counter, not the first end.
    throttled()
    throttled()
    expect(onEnd).toHaveBeenCalledTimes(2)
  })
})

describe('the calm state', () => {
  it('stays off entirely while the flag is off', () => {
    beginResizeGesture()
    vi.advanceTimersByTime(1000)

    expect(document.documentElement.dataset.resizing).toBeUndefined()
  })

  it('engages only after the grace period, and lifts after the gesture', () => {
    $calmDuringResize.set(true)

    beginResizeGesture()
    // A nudge shorter than the grace must never flash the veil.
    vi.advanceTimersByTime(100)
    expect(document.documentElement.dataset.resizing).toBeUndefined()

    vi.advanceTimersByTime(200)
    expect(document.documentElement.dataset.resizing).toBe('')

    endResizeGesture()
    // Lifted a frame later, so the gesture's own final flush paints underneath it.
    vi.advanceTimersByTime(32)
    expect(document.documentElement.dataset.resizing).toBeUndefined()
  })
})

describe('rate helpers', () => {
  it('reports every category at the active preset', () => {
    $resizeThrottle.set('smooth')

    expect(resizeThrottleMs('chat')).toBe(RESIZE_THROTTLE_MS.smooth)
    expect(resizeThrottleMs('terminal')).toBe(RESIZE_THROTTLE_MS.smooth)
    expect(resizeThrottleMs('virtual')).toBe(RESIZE_THROTTLE_MS.smooth)
  })

  it('derives the caption rate, with 0 meaning unthrottled', () => {
    expect(resizeThrottleHz('balanced')).toBe(6)
    expect(resizeThrottleHz('smooth')).toBe(10)
    expect(resizeThrottleHz('off')).toBe(0)
  })
})
