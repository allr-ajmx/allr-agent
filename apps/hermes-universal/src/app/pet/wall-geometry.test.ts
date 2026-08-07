import { describe, expect, it } from 'vitest'

import {
  clampToBox,
  cornerNeighbour,
  facingSign,
  fallTarget,
  FEET_DROP_PX,
  gravitySign,
  isRestingOn,
  nearestWall,
  normalAxis,
  resolveSurface,
  restCoord,
  spansOverlap,
  spriteRotation,
  type Surface,
  surfacesFromBox,
  tangentAxis,
  type WalkBox
} from './wall-geometry'

// A portrait phone. The aspect ratio is the point: it is what breaks a naive
// nearest-edge test.
const PHONE: WalkBox = { bottom: 800, left: 0, right: 400, top: 0 }
const PET_W = 63
const PET_H = 69

describe('axes and gravity', () => {
  it('measures floors and ceilings along y, walls along x', () => {
    expect(normalAxis('floor')).toBe('y')
    expect(normalAxis('ceiling')).toBe('y')
    expect(normalAxis('left')).toBe('x')
    expect(normalAxis('right')).toBe('x')
  })

  it('walks across the axis it is measured on', () => {
    expect(tangentAxis('floor')).toBe('x')
    expect(tangentAxis('ceiling')).toBe('x')
    expect(tangentAxis('left')).toBe('y')
    expect(tangentAxis('right')).toBe('y')
  })

  it('pulls toward the surface, whichever way that is', () => {
    expect(gravitySign('floor')).toBe(1)
    expect(gravitySign('right')).toBe(1)
    expect(gravitySign('ceiling')).toBe(-1)
    expect(gravitySign('left')).toBe(-1)
  })
})

describe('restCoord', () => {
  const at = (wall: Surface['wall'], pos: number): number => restCoord({ from: 0, pos, to: 100, wall }, PET_W, PET_H)

  it('puts the pet above a floor, sunk by the foot padding', () => {
    expect(at('floor', 800)).toBe(800 - PET_H + FEET_DROP_PX)
  })

  it('puts the pet below a ceiling, sunk the other way', () => {
    expect(at('ceiling', 0)).toBe(-FEET_DROP_PX)
  })

  it('puts the pet left of a right wall', () => {
    expect(at('right', 400)).toBe(400 - PET_W + FEET_DROP_PX)
  })

  it('puts the pet right of a left wall', () => {
    expect(at('left', 0)).toBe(-FEET_DROP_PX)
  })
})

describe('nearestWall', () => {
  it('normalises by each axis, so a tall screen still has a floor', () => {
    // Bottom-centre. Raw pixel distance says a side wall is nearer (200px away
    // vs 100 to the bottom is fine here, but at x=120 the raw answer flips);
    // normalised, the answer is the one a person would give.
    expect(nearestWall({ x: 120, y: 700 }, PET_W, PET_H, PHONE)).toBe('floor')
  })

  it('answers left near the left edge', () => {
    expect(nearestWall({ x: 4, y: 400 }, PET_W, PET_H, PHONE)).toBe('left')
  })

  it('answers right near the right edge', () => {
    expect(nearestWall({ x: 330, y: 400 }, PET_W, PET_H, PHONE)).toBe('right')
  })

  it('answers ceiling near the top', () => {
    expect(nearestWall({ x: 180, y: 6 }, PET_W, PET_H, PHONE)).toBe('ceiling')
  })

  it('drops rather than drifting sideways from dead centre', () => {
    const centre = { x: PHONE.right / 2 - PET_W / 2, y: PHONE.bottom / 2 - PET_H / 2 }

    expect(nearestWall(centre, PET_W, PET_H, PHONE)).toBe('floor')
  })

  it('never divides by zero on a degenerate box', () => {
    const flat: WalkBox = { bottom: 0, left: 0, right: 0, top: 0 }

    expect(() => nearestWall({ x: 0, y: 0 }, PET_W, PET_H, flat)).not.toThrow()
  })
})

describe('surfacesFromBox', () => {
  it('gives only the floor when walls are off (desktop)', () => {
    const surfaces = surfacesFromBox(PHONE, PET_W, PET_H, false)

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.wall).toBe('floor')
  })

  it('gives all four edges when walls are on (mobile)', () => {
    const surfaces = surfacesFromBox(PHONE, PET_W, PET_H, true)

    expect(surfaces.map(s => s.wall).sort()).toEqual(['ceiling', 'floor', 'left', 'right'])
  })

  it('bounds each span by the pet extent along that span', () => {
    const [floor, , left] = surfacesFromBox(PHONE, PET_W, PET_H, true)

    // A floor span bounds the pet's LEFT edge, so it stops a pet-width early.
    expect(floor?.to).toBe(PHONE.right - PET_W)
    // A wall span bounds the pet's TOP edge, so it stops a pet-height early.
    expect(left?.to).toBe(PHONE.bottom - PET_H)
  })

  it('honours an inset box rather than the raw viewport', () => {
    const notched: WalkBox = { bottom: 766, left: 0, right: 400, top: 47 }
    const [floor] = surfacesFromBox(notched, PET_W, PET_H, true)

    expect(floor?.pos).toBe(766)
  })
})

describe('spansOverlap', () => {
  it('is true when there is room to step across', () => {
    expect(spansOverlap({ from: 0, to: 100 }, { from: 50, to: 150 })).toBe(true)
  })

  it('is false for a shave of overlap the pet cannot use', () => {
    expect(spansOverlap({ from: 0, to: 100 }, { from: 99, to: 200 })).toBe(false)
  })

  it('is false for disjoint spans', () => {
    expect(spansOverlap({ from: 0, to: 40 }, { from: 60, to: 100 })).toBe(false)
  })
})

describe('fallTarget', () => {
  const surfaces = surfacesFromBox(PHONE, PET_W, PET_H, true)
  const perch: Surface = { from: 0, pos: 600, to: 337, wall: 'floor' }

  it('lands on the nearest floor beneath, so a perch beats the screen bottom', () => {
    const hit = fallTarget([...surfaces, perch], 'floor', { x: 100, y: 200 }, PET_W, PET_H)

    expect(hit?.pos).toBe(600)
  })

  it('ignores a perch the pet is already below', () => {
    const hit = fallTarget([...surfaces, perch], 'floor', { x: 100, y: 700 }, PET_W, PET_H)

    expect(hit?.pos).toBe(PHONE.bottom)
  })

  it('ignores surfaces the pet is not over', () => {
    const narrow: Surface = { from: 300, pos: 600, to: 340, wall: 'floor' }
    const hit = fallTarget([...surfaces, narrow], 'floor', { x: 10, y: 200 }, PET_W, PET_H)

    expect(hit?.pos).toBe(PHONE.bottom)
  })

  it('works sideways for a wall, not just downward', () => {
    const hit = fallTarget(surfaces, 'right', { x: 100, y: 400 }, PET_W, PET_H)

    expect(hit?.wall).toBe('right')
  })
})

describe('resolveSurface', () => {
  const surfaces = surfacesFromBox(PHONE, PET_W, PET_H, true)

  it('keeps a settled pet on the surface it is resting on', () => {
    const floor = surfaces.find(s => s.wall === 'floor')!
    const at = { x: 100, y: restCoord(floor, PET_W, PET_H) }

    expect(resolveSurface(surfaces, at, PET_W, PET_H, PHONE).wall).toBe('floor')
  })

  it('sends an airborne pet to the nearest wall', () => {
    expect(resolveSurface(surfaces, { x: 340, y: 400 }, PET_W, PET_H, PHONE).wall).toBe('right')
  })
})

describe('isRestingOn', () => {
  const floor: Surface = { from: 0, pos: 800, to: 337, wall: 'floor' }

  it('is true at the rest coord', () => {
    expect(isRestingOn(floor, { x: 10, y: restCoord(floor, PET_W, PET_H) }, PET_W, PET_H)).toBe(true)
  })

  it('is false in mid-air', () => {
    expect(isRestingOn(floor, { x: 10, y: 200 }, PET_W, PET_H)).toBe(false)
  })

  it('is false past the end of the span', () => {
    expect(isRestingOn(floor, { x: 380, y: restCoord(floor, PET_W, PET_H) }, PET_W, PET_H)).toBe(false)
  })
})

describe('cornerNeighbour', () => {
  it('turns off the end of a floor onto the side walls', () => {
    expect(cornerNeighbour('floor', 'to')).toBe('right')
    expect(cornerNeighbour('floor', 'from')).toBe('left')
  })

  it('turns off the end of a wall onto the floor or ceiling', () => {
    expect(cornerNeighbour('right', 'to')).toBe('floor')
    expect(cornerNeighbour('right', 'from')).toBe('ceiling')
    expect(cornerNeighbour('left', 'to')).toBe('floor')
  })

  it('round-trips: walking off a floor and back returns to the floor', () => {
    const wall = cornerNeighbour('floor', 'to')

    expect(cornerNeighbour(wall, 'to')).toBe('floor')
  })
})

describe('clampToBox', () => {
  it('keeps the whole sprite inside', () => {
    expect(clampToBox({ x: 9999, y: 9999 }, PET_W, PET_H, PHONE)).toEqual({
      x: PHONE.right - PET_W,
      y: PHONE.bottom - PET_H
    })
  })

  it('respects an inset top', () => {
    const notched: WalkBox = { bottom: 766, left: 8, right: 392, top: 47 }

    expect(clampToBox({ x: -50, y: -50 }, PET_W, PET_H, notched)).toEqual({ x: 8, y: 47 })
  })

  it('pins rather than inverting when the box is smaller than the pet', () => {
    const tiny: WalkBox = { bottom: 20, left: 0, right: 20, top: 0 }

    expect(clampToBox({ x: 5, y: 5 }, PET_W, PET_H, tiny)).toEqual({ x: 0, y: 0 })
  })
})

describe('spriteRotation', () => {
  it('rotates so the feet meet the surface', () => {
    expect(spriteRotation('floor')).toBe(0)
    expect(spriteRotation('right')).toBe(-90)
    expect(spriteRotation('left')).toBe(90)
    expect(spriteRotation('ceiling')).toBe(180)
  })
})

describe('facingSign', () => {
  it('flips on the two walls whose rotation reverses the tangent', () => {
    expect(facingSign('floor')).toBe(1)
    expect(facingSign('left')).toBe(1)
    expect(facingSign('right')).toBe(-1)
    expect(facingSign('ceiling')).toBe(-1)
  })

  // The claim the sign encodes: rotating the sprite's own +x by the wall's
  // rotation lands on ±1 along that wall's tangent axis. If someone changes
  // `spriteRotation`, this is what tells them `facingSign` must follow.
  it('agrees with where spriteRotation actually points the sprite', () => {
    for (const wall of ['floor', 'ceiling', 'left', 'right'] as const) {
      const rad = (spriteRotation(wall) * Math.PI) / 180
      // (1, 0) rotated by θ, with screen y pointing down.
      const spriteRight = { x: Math.cos(rad), y: Math.sin(rad) }
      const alongTangent = tangentAxis(wall) === 'x' ? spriteRight.x : spriteRight.y

      expect(Math.sign(Math.round(alongTangent))).toBe(facingSign(wall))
    }
  })
})
