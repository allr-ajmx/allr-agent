import { describe, expect, it } from 'vitest'

import { resolveScrub, SCRUB_END_STOP_PX, SCRUB_STEP_PX } from './timeline-scrub'

// Ten turns, engaged in the middle — room to move either way before an end stop.
const COUNT = 10
const SEED = 4

describe('resolveScrub inside the rail', () => {
  it('holds the seed when the finger has not moved', () => {
    const scrub = resolveScrub(SEED, 0, COUNT)

    expect(scrub.index).toBe(SEED)
    expect(scrub.overshoot).toBe(0)
    expect(scrub.atEndStop).toBe(false)
  })

  it('moves one turn per step, down toward the newest', () => {
    expect(resolveScrub(SEED, SCRUB_STEP_PX, COUNT).index).toBe(SEED + 1)
    expect(resolveScrub(SEED, 3 * SCRUB_STEP_PX, COUNT).index).toBe(SEED + 3)
  })

  it('moves the other way toward the oldest', () => {
    expect(resolveScrub(SEED, -SCRUB_STEP_PX, COUNT).index).toBe(SEED - 1)
    expect(resolveScrub(SEED, -3 * SCRUB_STEP_PX, COUNT).index).toBe(SEED - 3)
  })

  it('rounds to the nearer turn part-way through a step', () => {
    expect(resolveScrub(SEED, SCRUB_STEP_PX * 0.4, COUNT).index).toBe(SEED)
    expect(resolveScrub(SEED, SCRUB_STEP_PX * 0.6, COUNT).index).toBe(SEED + 1)
  })

  it('needs a real step to change the selection — a wobble does not', () => {
    // The whole point of the pitch: 8px used to be a whole turn.
    expect(resolveScrub(SEED, 8, COUNT).index).toBe(SEED)
    expect(resolveScrub(SEED, -8, COUNT).index).toBe(SEED)
  })
})

describe('resolveScrub past the end stop', () => {
  it('stops at the oldest turn however far past it you pull', () => {
    const scrub = resolveScrub(SEED, -100 * SCRUB_STEP_PX, COUNT)

    expect(scrub.index).toBe(0)
    expect(scrub.atEndStop).toBe(true)
  })

  it('stops at the newest turn the same way', () => {
    const scrub = resolveScrub(SEED, 100 * SCRUB_STEP_PX, COUNT)

    expect(scrub.index).toBe(COUNT - 1)
    expect(scrub.atEndStop).toBe(true)
  })

  it('reports the excess signed, so the two ends are distinguishable', () => {
    // Four steps reaches the first turn from SEED=4; the fifth is all overdrag.
    expect(resolveScrub(SEED, -5 * SCRUB_STEP_PX, COUNT).overshoot).toBe(-SCRUB_STEP_PX)
    // Five steps reaches the last (index 9); the sixth is overdrag.
    expect(resolveScrub(SEED, 6 * SCRUB_STEP_PX, COUNT).overshoot).toBe(SCRUB_STEP_PX)
  })

  it('treats the end stop itself as inside', () => {
    expect(resolveScrub(SEED, -4 * SCRUB_STEP_PX, COUNT).overshoot).toBe(0)
    expect(resolveScrub(SEED, 5 * SCRUB_STEP_PX, COUNT).overshoot).toBe(0)
  })

  it('holds the buzz until the overdrag is worth announcing', () => {
    const shy = resolveScrub(0, -(SCRUB_END_STOP_PX - 1), COUNT)
    const past = resolveScrub(0, -SCRUB_END_STOP_PX, COUNT)

    expect(shy.atEndStop).toBe(false)
    expect(past.atEndStop).toBe(true)
  })
})

describe('resolveScrub on a degenerate rail', () => {
  it('answers an actionable index with no entries', () => {
    const scrub = resolveScrub(0, 500, 0)

    expect(scrub.index).toBe(0)
    expect(scrub.overshoot).toBe(0)
    expect(scrub.atEndStop).toBe(false)
  })

  it('pins a single-entry rail to its only turn', () => {
    expect(resolveScrub(0, 500, 1).index).toBe(0)
    expect(resolveScrub(0, -500, 1).index).toBe(0)
  })
})
