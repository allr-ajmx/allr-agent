/**
 * Surfaces with an orientation — the geometry that lets the pet walk a wall.
 *
 * The floor-only model this replaces had "down" baked into every calculation:
 * `y` was the surface line, `left`/`right` bounded the walk, gravity was +y.
 * On a desktop window that is fine. On a phone it is a waste of the only two
 * edges a handset has plenty of, and it puts the pet in the one place a phone
 * cannot spare — the strip above the composer.
 *
 * So a surface now carries which wall it is, and *everything else derives from
 * that*: which axis is the normal, which is the tangent, which way gravity
 * pulls, and where the pet's top-left sits when it is resting. The payoff is
 * that the beat-to-beat decisions in `roam-behavior` never learn about walls at
 * all — they work on a tangent span, and a span is a span whether it runs
 * across the bottom of the screen or up the side of it.
 *
 * Pure: no DOM, no time, no randomness beyond what the caller passes in.
 */

export type Wall = 'floor' | 'ceiling' | 'left' | 'right'

export type Axis = 'x' | 'y'

/** A walkable range along a surface's tangent axis, bounding the pet's
 *  top-left corner so the whole sprite stays on the surface. */
export interface Span {
  from: number
  to: number
}

export interface Surface extends Span {
  wall: Wall
  /** The surface line, along the NORMAL axis: the y of a floor/ceiling, the x
   *  of a left/right wall. */
  pos: number
}

/** The area the pet is allowed to occupy, in viewport coordinates. */
export interface WalkBox {
  top: number
  right: number
  bottom: number
  left: number
}

// Sprites carry a few px of transparent padding past the feet; sink the pet by
// this much so the visible feet meet the surface instead of hovering above it.
// Along the normal axis, so it works on a wall exactly as it does on the floor.
export const FEET_DROP_PX = 4

/** How close the pet's resting coord must be to count as "on this surface". */
export const SURFACE_EPS = 2

const NORMAL: Record<Wall, Axis> = { ceiling: 'y', floor: 'y', left: 'x', right: 'x' }

/** The axis a surface is measured along — the one gravity acts on. */
export const normalAxis = (wall: Wall): Axis => NORMAL[wall]

/** The axis the pet walks along. */
export const tangentAxis = (wall: Wall): Axis => (NORMAL[wall] === 'y' ? 'x' : 'y')

/**
 * Which way the pet accelerates to reach this surface. A floor is below you, so
 * +y; a ceiling is above, so -y; the right wall is at +x and the left at -x.
 */
export const gravitySign = (wall: Wall): -1 | 1 => (wall === 'floor' || wall === 'right' ? 1 : -1)

/**
 * Where the pet's top-left sits, along the normal axis, when resting here.
 *
 * The two "far" walls (floor, right) subtract the sprite's extent because the
 * pet's box grows away from its top-left corner toward them; the two "near"
 * walls (ceiling, left) don't. `FEET_DROP_PX` always pushes *into* the surface.
 */
export function restCoord(surface: Surface, petW: number, petH: number): number {
  switch (surface.wall) {
    case 'floor':
      return surface.pos - petH + FEET_DROP_PX

    case 'ceiling':
      return surface.pos - FEET_DROP_PX

    case 'right':
      return surface.pos - petW + FEET_DROP_PX

    case 'left':
      return surface.pos - FEET_DROP_PX
  }
}

/** The pet's extent along an axis. */
export const petExtent = (axis: Axis, petW: number, petH: number): number => (axis === 'x' ? petW : petH)

export const coordOn = (point: { x: number; y: number }, axis: Axis): number => (axis === 'x' ? point.x : point.y)

/**
 * Do two surfaces' walkable spans overlap enough to step across? Unchanged in
 * spirit from the floor-only version — it just no longer assumes x.
 */
export const spansOverlap = (a: Span, b: Span): boolean => Math.min(a.to, b.to) > Math.max(a.from, b.from) + 2

/**
 * The wall the pet should fall toward: the nearest edge of the box, with each
 * distance normalised by that axis's half-extent.
 *
 * The normalisation is the whole point. On a 390×800 phone, raw distances make
 * a side wall nearer than the floor for almost every position on screen, so an
 * un-normalised answer is "left" or "right" nearly always and the pet would
 * never visit the bottom. Scaling by half-extent asks "how far across this axis
 * are you", which is the question a person means by *nearest*.
 */
export function nearestWall(pet: { x: number; y: number }, petW: number, petH: number, box: WalkBox): Wall {
  const halfW = Math.max(1, (box.right - box.left) / 2)
  const halfH = Math.max(1, (box.bottom - box.top) / 2)
  const cx = pet.x + petW / 2
  const cy = pet.y + petH / 2

  const candidates: { wall: Wall; d: number }[] = [
    { d: (cy - box.top) / halfH, wall: 'ceiling' },
    { d: (box.bottom - cy) / halfH, wall: 'floor' },
    { d: (cx - box.left) / halfW, wall: 'left' },
    { d: (box.right - cx) / halfW, wall: 'right' }
  ]

  // Ties resolve in array order, which puts `floor` ahead of the side walls —
  // dead centre should drop, not drift sideways.
  let best = candidates[1]!

  for (const c of candidates) {
    if (c.d < best.d) {
      best = c
    }
  }

  return best.wall
}

/** The four edges of the box as walkable surfaces. */
export function surfacesFromBox(box: WalkBox, petW: number, petH: number, walls: boolean): Surface[] {
  const floor: Surface = {
    from: box.left,
    pos: box.bottom,
    to: Math.max(box.left, box.right - petW),
    wall: 'floor'
  }

  if (!walls) {
    return [floor]
  }

  return [
    floor,
    { from: box.left, pos: box.top, to: Math.max(box.left, box.right - petW), wall: 'ceiling' },
    { from: box.top, pos: box.left, to: Math.max(box.top, box.bottom - petH), wall: 'left' },
    { from: box.top, pos: box.right, to: Math.max(box.top, box.bottom - petH), wall: 'right' }
  ]
}

/** Is the pet resting on this surface right now? */
export function isRestingOn(
  surface: Surface,
  pet: { x: number; y: number },
  petW: number,
  petH: number,
  eps = SURFACE_EPS
): boolean {
  const normal = normalAxis(surface.wall)
  const tangent = tangentAxis(surface.wall)
  const along = coordOn(pet, tangent)

  return (
    Math.abs(coordOn(pet, normal) - restCoord(surface, petW, petH)) <= eps &&
    along >= surface.from - eps &&
    along <= surface.to + eps
  )
}

/**
 * What the pet would land on if it fell toward `wall` from where it is: the
 * nearest surface of that orientation that lies ahead of it and spans its
 * tangent position.
 *
 * This is what makes a perch work in a wall-walking world with no special
 * casing — the composer is just another `floor` surface, and one the pet
 * reaches before the bottom of the screen.
 */
export function fallTarget(
  surfaces: Surface[],
  wall: Wall,
  pet: { x: number; y: number },
  petW: number,
  petH: number
): null | Surface {
  const normal = normalAxis(wall)
  const tangent = tangentAxis(wall)
  const g = gravitySign(wall)
  const at = coordOn(pet, normal)
  const along = coordOn(pet, tangent)
  let best: null | Surface = null
  let bestD = Infinity

  for (const surface of surfaces) {
    if (surface.wall !== wall || along < surface.from - 2 || along > surface.to + 2) {
      continue
    }

    // Ahead along gravity (or where we already are, within eps).
    const d = (restCoord(surface, petW, petH) - at) * g

    if (d >= -SURFACE_EPS && d < bestD) {
      bestD = d
      best = surface
    }
  }

  return best
}

/**
 * The surface the pet is on, or should fall to. Prefers one it is already
 * resting on so a settled pet doesn't get re-homed mid-loaf by a nearest-wall
 * answer that has drifted.
 */
export function resolveSurface(
  surfaces: Surface[],
  pet: { x: number; y: number },
  petW: number,
  petH: number,
  box: WalkBox
): Surface {
  for (const surface of surfaces) {
    if (isRestingOn(surface, pet, petW, petH)) {
      return surface
    }
  }

  const wall = nearestWall(pet, petW, petH, box)

  return fallTarget(surfaces, wall, pet, petW, petH) ?? surfaces[0]!
}

/**
 * The wall around the corner from one end of a span — what the pet steps onto
 * when a stroll runs out of surface. Without this the pet only ever wall-walks
 * because you dragged it there; with it, it gets there on its own.
 */
export function cornerNeighbour(wall: Wall, end: 'from' | 'to'): Wall {
  if (wall === 'floor' || wall === 'ceiling') {
    return end === 'to' ? 'right' : 'left'
  }

  return end === 'to' ? 'floor' : 'ceiling'
}

/** Clamp a point so the pet's whole box stays inside the walkable area. */
export function clampToBox(
  pet: { x: number; y: number },
  petW: number,
  petH: number,
  box: WalkBox
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(pet.x, box.left), Math.max(box.left, box.right - petW)),
    y: Math.min(Math.max(pet.y, box.top), Math.max(box.top, box.bottom - petH))
  }
}

/** The sprite's rotation, in degrees, for a pet standing on `wall`. Rotating
 *  rather than only mirroring is what keeps the feet against the surface. */
export function spriteRotation(wall: Wall): number {
  switch (wall) {
    case 'floor':
      return 0

    case 'right':
      return -90

    case 'left':
      return 90

    case 'ceiling':
      return 180
  }
}

/**
 * Which way along the tangent the UNMIRRORED sprite faces, once `spriteRotation`
 * has been applied.
 *
 * The mirror is composed after the rotation, so it flips the sprite's own x —
 * and the sprite's own x stops being the screen's the moment the pet leaves the
 * floor. Rotating (x, y) by θ (screen y down) sends (1, 0) to
 * (cos θ, sin θ), so sprite-right lands on:
 *
 *   floor    0°  → +x  = +tangent  → +1
 *   left   +90°  → +y  = +tangent  → +1
 *   right  −90°  → −y  = −tangent  → −1
 *   ceiling 180° → −x  = −tangent  → −1
 *
 * Multiply a tangent-space direction by this before asking for a walk row, or
 * the pet moonwalks up the right wall and along the ceiling.
 */
export const facingSign = (wall: Wall): -1 | 1 => (wall === 'ceiling' || wall === 'right' ? -1 : 1)
