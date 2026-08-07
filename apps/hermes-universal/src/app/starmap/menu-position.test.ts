import { describe, expect, it } from 'vitest'

import { clampMenuPosition } from './menu-position'

// A phone-ish viewport and a menu that is a meaningful fraction of it — the
// case where clipping actually bites.
const VIEW = { vh: 800, vw: 400 }
const MENU = { h: 120, w: 160 }

describe('clampMenuPosition', () => {
  it('leaves a menu with room where it was anchored', () => {
    expect(clampMenuPosition({ ...VIEW, ...MENU, x: 50, y: 60 })).toEqual({ left: 50, top: 60 })
  })

  it('flips left of the anchor near the right edge', () => {
    // 380 + 160 would run 140px off screen.
    expect(clampMenuPosition({ ...VIEW, ...MENU, x: 380, y: 60 })).toEqual({ left: 220, top: 60 })
  })

  it('flips above the anchor near the bottom edge', () => {
    expect(clampMenuPosition({ ...VIEW, ...MENU, x: 50, y: 780 })).toEqual({ left: 50, top: 660 })
  })

  it('flips on both axes in the bottom-right corner', () => {
    expect(clampMenuPosition({ ...VIEW, ...MENU, x: 390, y: 790 })).toEqual({ left: 230, top: 670 })
  })

  it('keeps clear of the safe-area insets', () => {
    // A notched phone: the flip must land inside the inset, not merely on screen.
    const inset = { bottom: 34, left: 8, right: 8, top: 47 }

    expect(clampMenuPosition({ ...VIEW, ...MENU, inset, x: 396, y: 796 })).toEqual({ left: 232, top: 646 })
  })

  it('clamps an anchor that is itself outside the inset', () => {
    const inset = { bottom: 0, left: 20, right: 0, top: 40 }

    expect(clampMenuPosition({ ...VIEW, ...MENU, inset, x: -50, y: 0 })).toEqual({ left: 20, top: 40 })
  })

  it('pins to the top-left when the menu is larger than the viewport', () => {
    // Nothing fits; the top-left corner at least keeps the label visible rather
    // than sliding the menu off the opposite edge.
    const placed = clampMenuPosition({ h: 900, vh: 800, vw: 400, w: 500, x: 200, y: 200 })

    expect(placed).toEqual({ left: 0, top: 0 })
  })

  it('does not flip when the anchor sits exactly at the fitting boundary', () => {
    expect(clampMenuPosition({ ...VIEW, ...MENU, x: 240, y: 680 })).toEqual({ left: 240, top: 680 })
  })
})
