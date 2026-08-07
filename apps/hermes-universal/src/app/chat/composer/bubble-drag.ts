// The bubble carousel's drag arithmetic, kept apart from the component that
// measures and renders it — thresholds are exactly the kind of thing that is
// easy to get subtly wrong and impossible to check by reading, and this way
// they can be tested without a DOM.

/**
 * How much of an overdrag the track actually travels once it has hit an end
 * stop. Not zero: a dead edge reads as a broken gesture. Not one: the whole
 * point is that the strip stops tracking your finger, which is what tells you
 * there is nothing further along.
 */
export const RUBBER_BAND = 0.35

/** Overdrag past the end stop before the new-session bubble shows itself… */
export const NEW_SESSION_REVEAL_PX = 40

/** …and before letting go there actually creates one. The gap between the two
 *  is the part of the gesture you can still change your mind in. */
export const NEW_SESSION_COMMIT_PX = 96

/** Which empty side of the strip the new-session bubble occupies. */
export type NewSessionSide = 'end' | 'start'

export interface TrackBounds {
  /** Translate that centres the LAST bubble. */
  min: number
  /** Translate that centres the FIRST bubble. */
  max: number
}

export interface DragResolution {
  /** Where the track goes — clamped, plus the rubber-banded excess. */
  translate: number
  /** The translate with no overdrag: what the peeked bubble is chosen from, so
   *  the end bubble stays picked however far past it you drag. */
  clamped: number
  /** Signed excess past an end stop. Positive means dragged past the FIRST
   *  bubble (revealing empty space before it), negative past the LAST. */
  overshoot: number
  /** Non-null once the reveal threshold is crossed. */
  newSessionSide: NewSessionSide | null
  /** Past the commit threshold: releasing here opens a new session. */
  newSessionArmed: boolean
}

export function resolveDrag(raw: number, bounds: TrackBounds): DragResolution {
  // An unmeasured or single-bubble strip can invert the bounds; collapsing them
  // means every drag is overdrag, which is the sane degenerate behaviour.
  const max = Math.max(bounds.min, bounds.max)
  const min = Math.min(bounds.min, bounds.max)

  const clamped = Math.min(Math.max(raw, min), max)
  const overshoot = raw - clamped
  const magnitude = Math.abs(overshoot)

  return {
    clamped,
    newSessionArmed: magnitude >= NEW_SESSION_COMMIT_PX,
    newSessionSide: magnitude >= NEW_SESSION_REVEAL_PX ? (overshoot > 0 ? 'start' : 'end') : null,
    overshoot,
    translate: clamped + overshoot * RUBBER_BAND
  }
}

/** 0 → 1 across the reveal→commit span, for fading and growing the ghost so the
 *  commit point is visible before you reach it rather than announced after. */
export function newSessionProgress(overshoot: number): number {
  const magnitude = Math.abs(overshoot)

  if (magnitude <= NEW_SESSION_REVEAL_PX) {
    return 0
  }

  return Math.min(1, (magnitude - NEW_SESSION_REVEAL_PX) / (NEW_SESSION_COMMIT_PX - NEW_SESSION_REVEAL_PX))
}
