/**
 * The FPS HUD's maths.
 *
 * Tested because an FPS readout that is subtly wrong is worse than no readout —
 * it looks authoritative either way. The case that matters most is the last
 * describe block: the window that averages to "fine" while containing a hitch
 * the user plainly saw.
 */

import { describe, expect, it } from 'vitest'

import { FrameMeter, LONG_FRAME_MS, summarize } from './frame-meter'

/** N frames at a steady duration. */
const steady = (count: number, ms: number) => Array.from({ length: count }, () => ms)

describe('summarize', () => {
  it('is empty-safe', () => {
    expect(summarize([])).toEqual({ fps: 0, longFrames: 0, p95Ms: 0, sampleCount: 0, worstMs: 0 })
  })

  it('reports the reciprocal of the mean frame time', () => {
    expect(summarize(steady(60, 16.667)).fps).toBeCloseTo(60, 1)
    expect(summarize(steady(60, 33.333)).fps).toBeCloseTo(30, 1)
  })

  it('reports the worst frame, not just the average', () => {
    const stats = summarize([...steady(59, 16), 200])

    expect(stats.worstMs).toBe(200)
  })

  it('counts frames at or over the long-frame threshold', () => {
    const stats = summarize([16, LONG_FRAME_MS, LONG_FRAME_MS + 10, 16, LONG_FRAME_MS - 1])

    expect(stats.longFrames).toBe(2)
  })

  // p95 and worstMs answer DIFFERENT questions, and the split is the reason both
  // are on screen: p95 is "how bad is it when it is bad, repeatedly", worstMs is
  // "what was the single worst moment". Nearest rank on N=20 is the 19th value
  // (`ceil(0.95 * 20)`), so:
  it('reports a RECURRING hitch in p95, and leaves the one-off to worstMs', () => {
    // 1 bad in 20 is exactly 5% — it sits above p95, which is the correct answer
    // for a percentile and the reason worstMs exists beside it.
    const oneOff = summarize([...steady(19, 16), 120])

    expect(oneOff.p95Ms).toBe(16)
    expect(oneOff.worstMs).toBe(120)

    // 2 bad in 20 is 10% — now it is recurring, and p95 says so.
    expect(summarize([...steady(18, 16), 120, 130]).p95Ms).toBe(120)
  })

  it('never returns a non-finite fps when the clock did not move', () => {
    expect(summarize([0, 0]).fps).toBe(0)
  })
})

describe('the case average FPS hides', () => {
  // One 200ms frame in an otherwise perfect second. This is the whole reason the
  // HUD shows more than one number.
  const window = [...steady(59, 16.667), 200]

  it('still reads as an acceptable average', () => {
    expect(summarize(window).fps).toBeGreaterThan(45)
  })

  it('but the worst-frame and long-frame counters give it away', () => {
    const stats = summarize(window)

    expect(stats.worstMs).toBe(200)
    expect(stats.longFrames).toBe(1)
  })
})

describe('FrameMeter', () => {
  it('rejects the samples requestAnimationFrame actually produces at the edges', () => {
    const meter = new FrameMeter(10)

    meter.push(0) // clock did not move
    meter.push(-5) // clock went backwards
    meter.push(Number.NaN)
    meter.push(30_000) // returned from the background — real elapsed time, not a frame

    expect(meter.stats().sampleCount).toBe(0)
  })

  it('keeps a rolling window, dropping the oldest samples', () => {
    const meter = new FrameMeter(3)

    meter.push(10)
    meter.push(20)
    meter.push(30)
    meter.push(40)

    expect(meter.samples()).toEqual([20, 30, 40])
  })

  it('returns samples oldest-first even after the ring wraps', () => {
    const meter = new FrameMeter(3)

    for (const ms of [1, 2, 3, 4, 5]) {
      meter.push(ms)
    }

    expect(meter.samples()).toEqual([3, 4, 5])
  })

  describe('refreshHz', () => {
    it('defaults to 60 before anything has been measured', () => {
      expect(new FrameMeter().refreshHz()).toBe(60)
    })

    it('infers the panel rate from the fastest frame seen', () => {
      const sixty = new FrameMeter()
      sixty.push(16.7)
      expect(sixty.refreshHz()).toBe(60)

      const oneTwenty = new FrameMeter()
      oneTwenty.push(8.3)
      expect(oneTwenty.refreshHz()).toBe(120)
    })

    it('snaps to a real panel rate rather than reporting measurement noise', () => {
      const meter = new FrameMeter()
      meter.push(13.8) // ~72.5Hz — between panel rates, nearest is 72

      expect(meter.refreshHz()).toBe(72)
    })

    // The point of inferring it: 60fps is perfect on a 60Hz panel and a HALVING
    // on a 120Hz one, and the HUD colours the readout accordingly.
    it('survives a slow window, because it tracks the best frame ever seen', () => {
      const meter = new FrameMeter(4)

      meter.push(8.3)

      for (const ms of steady(10, 33)) {
        meter.push(ms)
      }

      expect(meter.refreshHz()).toBe(120)
      expect(meter.stats().fps).toBeCloseTo(30, 0)
    })
  })

  it('reset clears the window and the inferred refresh rate', () => {
    const meter = new FrameMeter()

    meter.push(8.3)
    meter.reset()

    expect(meter.samples()).toEqual([])
    expect(meter.refreshHz()).toBe(60)
  })
})
