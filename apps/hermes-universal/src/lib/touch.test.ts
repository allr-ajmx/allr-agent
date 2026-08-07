import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTap, dragSlopPx, MOUSE_DRAG_SLOP_PX, TAP_MAX_MS, TAP_SLOP_PX, TOUCH_DRAG_SLOP_PX } from './touch'

const touch = (x: number, y: number) => ({ clientX: x, clientY: y, pointerType: 'touch' })
const mouse = (x: number, y: number) => ({ clientX: x, clientY: y, pointerType: 'mouse' })

describe('createTap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires on a short, still release', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(10, 20))
    vi.advanceTimersByTime(80)

    expect(tap.up(touch(10, 20))).toBe(true)
    expect(onTap).toHaveBeenCalledOnce()
    expect(tap.fired()).toBe(true)
  })

  it('tolerates a wobble inside the slop radius', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(100, 100))
    tap.move(touch(100 + TAP_SLOP_PX / 2, 100 + TAP_SLOP_PX / 2))

    expect(tap.up(touch(100 + TAP_SLOP_PX / 2, 100 + TAP_SLOP_PX / 2))).toBe(true)
    expect(onTap).toHaveBeenCalledOnce()
  })

  it('does not fire once movement leaves the slop radius', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(100, 100))
    tap.move(touch(100 + TAP_SLOP_PX + 1, 100))

    expect(tap.up(touch(100, 100))).toBe(false)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('does not fire when the release itself lands outside the radius', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    // No intervening move — a coalesced drag can go straight from down to up.
    tap.down(touch(100, 100))

    expect(tap.up(touch(100, 100 + TAP_SLOP_PX + 1))).toBe(false)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('does not fire past the time cap', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(0, 0))
    vi.advanceTimersByTime(TAP_MAX_MS + 1)

    expect(tap.up(touch(0, 0))).toBe(false)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('never fires for a mouse — the native click owns a fine pointer', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(mouse(5, 5))

    expect(tap.up(mouse(5, 5))).toBe(false)
    expect(onTap).not.toHaveBeenCalled()
    expect(tap.fired()).toBe(false)
  })

  it('does not fire twice from one press', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(0, 0))
    tap.up(touch(0, 0))

    expect(tap.up(touch(0, 0))).toBe(false)
    expect(onTap).toHaveBeenCalledOnce()
  })

  it('clears the fired flag on the next press, so a stale click is not swallowed', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(0, 0))
    tap.up(touch(0, 0))
    expect(tap.fired()).toBe(true)

    tap.down(touch(0, 0))
    expect(tap.fired()).toBe(false)
  })

  it('cancels an armed press', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    tap.down(touch(0, 0))
    tap.cancel()

    expect(tap.up(touch(0, 0))).toBe(false)
    expect(onTap).not.toHaveBeenCalled()
    expect(tap.fired()).toBe(false)
  })

  it('ignores movement and release when nothing is armed', () => {
    const onTap = vi.fn()
    const tap = createTap({ onTap })

    expect(() => tap.move(touch(500, 500))).not.toThrow()
    expect(tap.up(touch(500, 500))).toBe(false)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('honours a custom cap and slop', () => {
    const onTap = vi.fn()
    const tap = createTap({ maxMs: 100, onTap, slopPx: 2 })

    tap.down(touch(0, 0))
    tap.move(touch(3, 0))
    expect(tap.up(touch(3, 0))).toBe(false)

    tap.down(touch(0, 0))
    vi.advanceTimersByTime(101)
    expect(tap.up(touch(0, 0))).toBe(false)

    tap.down(touch(0, 0))
    expect(tap.up(touch(1, 0))).toBe(true)
    expect(onTap).toHaveBeenCalledOnce()
  })
})

describe('dragSlopPx', () => {
  it('gives a finger more room than a mouse', () => {
    expect(dragSlopPx('mouse')).toBe(MOUSE_DRAG_SLOP_PX)
    expect(dragSlopPx('touch')).toBe(TOUCH_DRAG_SLOP_PX)
    expect(dragSlopPx('pen')).toBe(TOUCH_DRAG_SLOP_PX)
    expect(TOUCH_DRAG_SLOP_PX).toBeGreaterThan(TAP_SLOP_PX)
  })
})
