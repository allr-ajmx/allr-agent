// The prompt rail's scrub arithmetic, kept apart from the component that
// measures and renders it — the same split, and for the same reason, as the
// bubble carousel's `app/chat/composer/bubble-drag.ts`: a step distance is easy
// to get subtly wrong and impossible to check by reading.
//
// The rail used to pick whichever tick the finger was nearest, which made the
// gesture ABSOLUTE: ticks are 8px tall, so 8px of travel changed the turn and
// the whole strip was only `entries * 8px` of reachable space. This maps the
// finger RELATIVELY instead — from wherever the hold engaged, at a fixed pitch,
// with no end the strip's own height imposes.

/**
 * Finger travel per turn. Deliberately much larger than a tick (8px): the rail
 * is dragged with a thumb on a phone, and the previous pitch meant a wobble
 * changed the selection. The gesture takes pointer capture, so the finger can
 * keep going well past the strip — distance is not the thing in short supply.
 */
export const SCRUB_STEP_PX = 32

/**
 * Overdrag past the first/last turn before the rail says so. Nothing here
 * translates the way the carousel's track does, so a haptic on the crossing is
 * the only "there is nothing further along" this control can offer.
 */
export const SCRUB_END_STOP_PX = 24

export interface ScrubResolution {
  /** The selected turn. Always an index a caller can act on. */
  index: number
  /** Signed px past an end stop: negative past the FIRST turn, positive past
   *  the LAST, zero anywhere inside. */
  overshoot: number
  /** Past the end-stop threshold — the buzz fires on this crossing, once. */
  atEndStop: boolean
}

/**
 * Where a scrub that engaged on `seed` and has travelled `deltaY` px lands.
 *
 * Down is forward: ticks run oldest-to-newest top-to-bottom, so a positive
 * `deltaY` moves toward the newest turn.
 */
export function resolveScrub(seed: number, deltaY: number, count: number): ScrubResolution {
  // An empty rail still has to answer an index the caller can act on — the
  // same degenerate-case posture as `resolveDrag`'s collapsed bounds.
  if (count <= 0) {
    return { atEndStop: false, index: 0, overshoot: 0 }
  }

  const raw = seed + deltaY / SCRUB_STEP_PX
  // Clamped FRACTIONALLY, then rounded. Rounding first would round -0.4 to 0
  // and report no overdrag, so the end stop would only be reached half a step
  // late — and the buzz with it.
  const clamped = Math.min(Math.max(raw, 0), count - 1)
  const overshoot = (raw - clamped) * SCRUB_STEP_PX

  return {
    atEndStop: Math.abs(overshoot) >= SCRUB_END_STOP_PX,
    index: Math.round(clamped),
    overshoot
  }
}
