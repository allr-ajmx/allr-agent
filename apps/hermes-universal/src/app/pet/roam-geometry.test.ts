import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { snapshotSurfaces, walkBox } from './roam-geometry'
import { restCoord } from './wall-geometry'

const PET_W = 63
const PET_H = 69

const INSETS = {
  '--safe-area-inset-bottom': '34px',
  '--safe-area-inset-left': '0px',
  '--safe-area-inset-right': '0px',
  '--safe-area-inset-top': '47px'
} as const

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w, writable: true })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h, writable: true })
}

function publishInsets(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(name, value)
  }
}

/** Mount an element and force a rect on it — jsdom lays nothing out. */
function mountWithRect(slot: string, rect: { top: number; left: number; right: number; bottom: number }): void {
  const el = document.createElement('div')

  el.setAttribute('data-slot', slot)
  el.getBoundingClientRect = () =>
    ({
      bottom: rect.bottom,
      height: rect.bottom - rect.top,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.right - rect.left,
      x: rect.left,
      y: rect.top
    }) as DOMRect
  document.body.appendChild(el)
}

beforeEach(() => {
  setViewport(400, 800)
})

afterEach(() => {
  document.body.innerHTML = ''

  for (const name of Object.keys(INSETS)) {
    document.documentElement.style.removeProperty(name)
  }

  document.documentElement.style.removeProperty('--keyboard-inset')
  vi.restoreAllMocks()
})

describe('walkBox', () => {
  it('is the raw viewport on desktop', () => {
    expect(walkBox(PET_H, false)).toEqual({ bottom: 800, left: 0, right: 400, top: 0 })
  })

  it('stands on the status bar when one is pinned across the bottom', () => {
    mountWithRect('statusbar', { bottom: 800, left: 0, right: 400, top: 776 })

    expect(walkBox(PET_H, false).bottom).toBe(776)
  })

  it('insets by the safe area on mobile', () => {
    publishInsets(INSETS)

    // This is the bug the pet had: with the raw viewport it stood ON the home
    // indicator and sat under the notch.
    expect(walkBox(PET_H, true)).toEqual({ bottom: 766, left: 0, right: 400, top: 47 })
  })

  it('lifts off the soft keyboard, which a fixed element is not lifted by', () => {
    publishInsets(INSETS)
    document.documentElement.style.setProperty('--keyboard-inset', '300px')

    expect(walkBox(PET_H, true).bottom).toBe(466)
  })

  it('never inverts when the keyboard leaves no room', () => {
    publishInsets(INSETS)
    document.documentElement.style.setProperty('--keyboard-inset', '5000px')

    const box = walkBox(PET_H, true)

    expect(box.bottom).toBeGreaterThanOrEqual(box.top)
  })
})

describe('snapshotSurfaces', () => {
  it('gives the floor and nothing else on desktop', () => {
    const surfaces = snapshotSurfaces(PET_W, PET_H, { safeArea: false, walls: false })

    expect(surfaces.map(s => s.wall)).toEqual(['floor'])
  })

  it('gives every edge on mobile', () => {
    publishInsets(INSETS)

    const walls = snapshotSurfaces(PET_W, PET_H, { safeArea: true, walls: true }).map(s => s.wall)

    expect(new Set(walls)).toEqual(new Set(['floor', 'ceiling', 'left', 'right']))
  })

  it('adds the composer top as a floor-oriented perch', () => {
    mountWithRect('composer-surface', { bottom: 800, left: 0, right: 400, top: 620 })

    const perches = snapshotSurfaces(PET_W, PET_H, { safeArea: false, walls: false }).filter(s => s.pos === 620)

    expect(perches).toHaveLength(1)
    // A perch is a floor wherever it appears — which is why wall-walking needed
    // no special case for it.
    expect(perches[0]?.wall).toBe('floor')
  })

  it('bounds a perch span so the whole sprite stays on it', () => {
    mountWithRect('composer-surface', { bottom: 800, left: 40, right: 360, top: 620 })

    const perch = snapshotSurfaces(PET_W, PET_H, { safeArea: false, walls: false }).find(s => s.pos === 620)

    expect(perch?.from).toBe(40)
    expect(perch?.to).toBe(360 - PET_W)
  })

  it('skips a perch too narrow for the pet', () => {
    mountWithRect('composer-surface', { bottom: 800, left: 0, right: 30, top: 620 })

    expect(snapshotSurfaces(PET_W, PET_H, { safeArea: false, walls: false }).some(s => s.pos === 620)).toBe(false)
  })

  it('skips a perch flush with the floor, with no daylight to stand in', () => {
    mountWithRect('composer-surface', { bottom: 800, left: 0, right: 400, top: 795 })

    expect(snapshotSurfaces(PET_W, PET_H, { safeArea: false, walls: false }).some(s => s.pos === 795)).toBe(false)
  })

  it('rests the pet above the perch rather than inside it', () => {
    mountWithRect('composer-surface', { bottom: 800, left: 0, right: 400, top: 620 })

    const perch = snapshotSurfaces(PET_W, PET_H, { safeArea: false, walls: false }).find(s => s.pos === 620)!

    expect(restCoord(perch, PET_W, PET_H)).toBeLessThan(620)
  })
})
