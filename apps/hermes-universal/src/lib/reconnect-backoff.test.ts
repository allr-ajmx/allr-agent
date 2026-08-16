import { describe, expect, it } from 'vitest'

import { reconnectBackoffDelayMs } from './reconnect-backoff'

// The jitter source is injected rather than spied on the global, so every
// expectation below is exact rather than statistical.
const pinned = (value: number) => () => value

describe('reconnectBackoffDelayMs', () => {
  it('increases the delay ceiling across consecutive failed attempts', () => {
    const delays = [0, 1, 2, 3, 4].map(attempt =>
      reconnectBackoffDelayMs(attempt, { baseDelayMs: 300, random: pinned(1) })
    )

    expect(delays).toEqual([300, 600, 1200, 2400, 4800])
  })

  it('caps the delay ceiling instead of growing unbounded', () => {
    // Attempt 10 would be 300 * 2**10 = 307_200ms uncapped — must clamp.
    expect(reconnectBackoffDelayMs(10, { baseDelayMs: 300, capMs: 15_000, random: pinned(1) })).toBe(15_000)
    expect(reconnectBackoffDelayMs(50, { baseDelayMs: 300, capMs: 15_000, random: pinned(1) })).toBe(15_000)
  })

  it('applies full jitter: the delay is the ceiling scaled by the jitter draw', () => {
    expect(reconnectBackoffDelayMs(3, { baseDelayMs: 300, random: pinned(0) })).toBe(0)
    expect(reconnectBackoffDelayMs(3, { baseDelayMs: 300, random: pinned(0.5) })).toBe(1200)
    expect(reconnectBackoffDelayMs(3, { baseDelayMs: 300, random: pinned(0.999) })).toBeCloseTo(2400 * 0.999, 5)
  })

  it('returns to the attempt-0 ceiling once the caller resets its counter', () => {
    const climbed = reconnectBackoffDelayMs(2, { baseDelayMs: 300, random: pinned(1) })
    const reset = reconnectBackoffDelayMs(0, { baseDelayMs: 300, random: pinned(1) })

    expect(climbed).toBe(1200)
    expect(reset).toBe(300)
  })

  it('treats negative attempt numbers as attempt 0 rather than returning a negative delay', () => {
    expect(reconnectBackoffDelayMs(-5, { baseDelayMs: 300, random: pinned(1) })).toBe(300)
  })

  it('uses sane defaults when no options are passed', () => {
    expect(reconnectBackoffDelayMs(0, { random: pinned(1) })).toBe(300)
    expect(reconnectBackoffDelayMs(100, { random: pinned(1) })).toBe(15_000)
  })

  it('defaults the jitter source to Math.random, staying inside the ceiling', () => {
    for (let i = 0; i < 50; i++) {
      const delay = reconnectBackoffDelayMs(2, { baseDelayMs: 300 })

      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(1200)
    }
  })
})
