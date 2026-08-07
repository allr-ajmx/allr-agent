import { describe, expect, it } from 'vitest'

import {
  NEW_SESSION_COMMIT_PX,
  NEW_SESSION_REVEAL_PX,
  newSessionProgress,
  resolveDrag,
  RUBBER_BAND,
  type TrackBounds
} from './bubble-drag'

// Four bubbles: the first centres at +120, the last at -120.
const BOUNDS: TrackBounds = { max: 120, min: -120 }

describe('resolveDrag inside the strip', () => {
  it('tracks the finger exactly and reports no overdrag', () => {
    const drag = resolveDrag(40, BOUNDS)

    expect(drag.translate).toBe(40)
    expect(drag.clamped).toBe(40)
    expect(drag.overshoot).toBe(0)
    expect(drag.newSessionSide).toBeNull()
    expect(drag.newSessionArmed).toBe(false)
  })

  it('treats the end stop itself as inside', () => {
    expect(resolveDrag(120, BOUNDS).overshoot).toBe(0)
    expect(resolveDrag(-120, BOUNDS).overshoot).toBe(0)
  })
})

describe('resolveDrag past the end stop', () => {
  it('rubber-bands the excess instead of dropping or following it', () => {
    const drag = resolveDrag(120 + 100, BOUNDS)

    expect(drag.overshoot).toBe(100)
    expect(drag.translate).toBe(120 + 100 * RUBBER_BAND)
    // Peek is chosen from `clamped`, which is what keeps the END bubble picked
    // however far past it you pull — the whole point of the clamp.
    expect(drag.clamped).toBe(120)
  })

  it('names the empty side by the direction of the pull', () => {
    expect(resolveDrag(120 + NEW_SESSION_REVEAL_PX, BOUNDS).newSessionSide).toBe('start')
    expect(resolveDrag(-120 - NEW_SESSION_REVEAL_PX, BOUNDS).newSessionSide).toBe('end')
  })

  it('stays hidden until the reveal threshold', () => {
    expect(resolveDrag(120 + NEW_SESSION_REVEAL_PX - 1, BOUNDS).newSessionSide).toBeNull()
  })

  it('arms only at the commit threshold, on either side', () => {
    expect(resolveDrag(120 + NEW_SESSION_COMMIT_PX - 1, BOUNDS).newSessionArmed).toBe(false)
    expect(resolveDrag(120 + NEW_SESSION_COMMIT_PX, BOUNDS).newSessionArmed).toBe(true)
    expect(resolveDrag(-120 - NEW_SESSION_COMMIT_PX, BOUNDS).newSessionArmed).toBe(true)
  })

  it('disarms when the drag comes back inside — the gesture stays reversible', () => {
    expect(resolveDrag(120 + NEW_SESSION_COMMIT_PX, BOUNDS).newSessionArmed).toBe(true)
    expect(resolveDrag(120 + NEW_SESSION_COMMIT_PX - 20, BOUNDS).newSessionArmed).toBe(false)
  })
})

describe('resolveDrag with degenerate bounds', () => {
  it('collapses inverted bounds rather than clamping to an empty range', () => {
    // An unmeasured strip can report min > max; every drag is then overdrag,
    // which is the sane degenerate behaviour — not a NaN or a stuck track.
    const drag = resolveDrag(50, { max: -10, min: 10 })

    expect(drag.clamped).toBe(10)
    expect(drag.overshoot).toBe(40)
  })
})

describe('newSessionProgress', () => {
  it('runs 0 → 1 across the reveal-to-commit span', () => {
    expect(newSessionProgress(NEW_SESSION_REVEAL_PX)).toBe(0)
    expect(newSessionProgress(NEW_SESSION_COMMIT_PX)).toBe(1)
    expect(newSessionProgress((NEW_SESSION_REVEAL_PX + NEW_SESSION_COMMIT_PX) / 2)).toBeCloseTo(0.5)
  })

  it('saturates past commit and ignores the pull direction', () => {
    expect(newSessionProgress(NEW_SESSION_COMMIT_PX * 3)).toBe(1)
    expect(newSessionProgress(-NEW_SESSION_COMMIT_PX)).toBe(1)
  })
})
