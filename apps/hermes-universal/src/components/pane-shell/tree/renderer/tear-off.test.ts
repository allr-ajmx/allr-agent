/**
 * The tear-off boundary: a drag released clear of the window gives the tile its
 * own window instead of cancelling.
 *
 * The pointer keeps reporting through a held drag, so a release past the edge
 * arrives as a coordinate outside the viewport — negative on the near sides,
 * past width/height on the far ones. The edges themselves are still inside: a
 * release exactly on the last visible pixel is a drop, not a tear-off.
 */

import { describe, expect, it } from 'vitest'

import { isOffWindow } from './drag-session'

describe('isOffWindow', () => {
  const off = (x: number, y: number) => isOffWindow(x, y, 1200, 800)

  it('is false anywhere inside, edges included', () => {
    expect(off(600, 400)).toBe(false)
    expect(off(0, 0)).toBe(false)
    expect(off(1200, 800)).toBe(false)
  })

  it('is true past any single edge', () => {
    expect(off(-1, 400)).toBe(true)
    expect(off(600, -1)).toBe(true)
    expect(off(1201, 400)).toBe(true)
    expect(off(600, 801)).toBe(true)
  })

  it('is true diagonally off — dragging out past a corner', () => {
    expect(off(-40, -40)).toBe(true)
    expect(off(1400, 900)).toBe(true)
  })
})
