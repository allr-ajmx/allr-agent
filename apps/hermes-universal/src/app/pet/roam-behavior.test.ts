import { describe, expect, it } from 'vitest'

import { chooseMove, dwellMs, HOP_CHANCE, PAUSE_DWELL, pickStrollTarget, REST_CHANCE } from './roam-behavior'
import type { Span } from './wall-geometry'

/** A scripted rng, so a "random" decision is an assertion rather than a hope. */
function scripted(...values: number[]): () => number {
  let i = 0

  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

describe('dwellMs', () => {
  it('floors at minMs so a near-zero draw is not a jittery micro-pause', () => {
    expect(dwellMs(PAUSE_DWELL, () => 0)).toBe(PAUSE_DWELL.minMs)
  })

  it('saturates at maxMs so a fat-tail draw cannot freeze the pet', () => {
    expect(dwellMs(PAUSE_DWELL, () => 1 - Number.EPSILON)).toBeLessThanOrEqual(PAUSE_DWELL.maxMs)
    expect(dwellMs(PAUSE_DWELL, () => 0.999999)).toBe(PAUSE_DWELL.maxMs)
  })

  it('lands inside the range for a middling draw', () => {
    const ms = dwellMs(PAUSE_DWELL, () => 0.5)

    expect(ms).toBeGreaterThanOrEqual(PAUSE_DWELL.minMs)
    expect(ms).toBeLessThanOrEqual(PAUSE_DWELL.maxMs)
  })
})

describe('chooseMove', () => {
  it('rests on the common draw — loafing is the default, not pacing', () => {
    expect(chooseMove(true, () => REST_CHANCE - 0.01)).toBe('rest')
  })

  it('hops when it moves, can hop, and the dice agree', () => {
    expect(chooseMove(true, scripted(REST_CHANCE + 0.01, HOP_CHANCE - 0.01))).toBe('hop')
  })

  it('strolls when the hop draw misses', () => {
    expect(chooseMove(true, scripted(REST_CHANCE + 0.01, HOP_CHANCE + 0.01))).toBe('stroll')
  })

  it('never hops in place when nothing is reachable', () => {
    expect(chooseMove(false, scripted(REST_CHANCE + 0.01, 0))).toBe('stroll')
  })
})

describe('pickStrollTarget', () => {
  const span: Span = { from: 0, to: 400 }

  it('covers ground rather than shuffling', () => {
    const target = pickStrollTarget(span, 0, () => 0)

    expect(Math.abs(target - 0)).toBeGreaterThanOrEqual(110)
  })

  it('stays inside the span', () => {
    for (const u of [0, 0.25, 0.5, 0.75, 0.999]) {
      const target = pickStrollTarget(span, 200, () => u)

      expect(target).toBeGreaterThanOrEqual(span.from)
      expect(target).toBeLessThanOrEqual(span.to)
    }
  })

  it('degenerates gracefully on a span with no room', () => {
    expect(pickStrollTarget({ from: 40, to: 42 }, 40, () => 0.5)).toBe(40)
  })

  it('is orientation-blind: the same span up a wall behaves identically', () => {
    // The span is a tangent range, so a floor from 0..400 and a wall from
    // 0..400 must produce the same answer — that is what let wall-walking
    // land without touching this file's logic.
    const onFloor = pickStrollTarget({ from: 0, to: 400 }, 100, () => 0.3)
    const onWall = pickStrollTarget({ from: 0, to: 400 }, 100, () => 0.3)

    expect(onWall).toBe(onFloor)
  })

  it('leans toward the roomier side', () => {
    // Sitting near the start, the roomier direction is "onward".
    expect(pickStrollTarget(span, 20, () => 0)).toBeGreaterThan(20)
  })
})
