import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLongPress, LONG_PRESS_MOVE_TOLERANCE_PX, LONG_PRESS_MS } from './long-press'

describe('createLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires once the hold elapses, with the press origin', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(10, 20)
    expect(press.pending()).toBe(true)

    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onFire).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20 })
    expect(press.pending()).toBe(false)
    expect(press.fired()).toBe(true)
  })

  it('does not fire again after firing', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(0, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS * 3)
    press.move(0, 0)
    press.up()
    vi.advanceTimersByTime(LONG_PRESS_MS * 3)

    expect(onFire).toHaveBeenCalledOnce()
  })

  it('tolerates a wobble inside the radius', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(100, 100)
    // Just inside the radius, on the diagonal.
    press.move(100 + LONG_PRESS_MOVE_TOLERANCE_PX / 2, 100 + LONG_PRESS_MOVE_TOLERANCE_PX / 2)
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(onFire).toHaveBeenCalledOnce()
  })

  it('cancels once movement leaves the radius', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(100, 100)
    press.move(100 + LONG_PRESS_MOVE_TOLERANCE_PX + 1, 100)
    expect(press.pending()).toBe(false)

    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('ignores movement when no press is armed', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    expect(() => press.move(500, 500)).not.toThrow()
    expect(press.pending()).toBe(false)
  })

  it('cancels on release before the hold elapses', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(0, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    press.up()
    vi.advanceTimersByTime(LONG_PRESS_MS)

    expect(onFire).not.toHaveBeenCalled()
  })

  it('cancels explicitly and clears the fired flag', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(0, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(press.fired()).toBe(true)

    press.cancel()
    expect(press.fired()).toBe(false)
  })

  it('re-arms from the new origin when down is called twice', () => {
    const onFire = vi.fn()
    const press = createLongPress({ onFire })

    press.down(0, 0)
    vi.advanceTimersByTime(LONG_PRESS_MS - 10)
    press.down(300, 300)
    vi.advanceTimersByTime(LONG_PRESS_MS - 10)
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10)
    expect(onFire).toHaveBeenCalledExactlyOnceWith({ x: 300, y: 300 })
  })

  it('honours a custom duration and tolerance', () => {
    const onFire = vi.fn()
    const press = createLongPress({ moveTolerancePx: 2, ms: 100, onFire })

    press.down(0, 0)
    press.move(3, 0)
    vi.advanceTimersByTime(100)
    expect(onFire).not.toHaveBeenCalled()

    press.down(0, 0)
    vi.advanceTimersByTime(100)
    expect(onFire).toHaveBeenCalledOnce()
  })
})
