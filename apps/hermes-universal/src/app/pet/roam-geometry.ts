/**
 * The "where can it stand" layer of the floating pet's wander: it measures the
 * live DOM and hands back walkable surfaces. The orientation-aware maths lives
 * in `wall-geometry.ts`; this file is the part that touches the document.
 *
 * Originally ported from apps/desktop, floor-only. It now produces oriented
 * `Surface`s so a phone can walk all four edges — see wall-geometry's header
 * for why. Desktop behaviour is preserved exactly by asking for `walls: false`,
 * which yields the bottom floor plus perches and nothing else.
 */

import { readKeyboardInset, readSafeAreaInsets } from '@/lib/safe-area'

import { type Surface, surfacesFromBox, type WalkBox } from './wall-geometry'

export type { Surface } from './wall-geometry'

// Elements the pet can perch on top of, measured fresh each beat. The box edges
// are always walkable; these add app furniture the pet can climb onto.
const PERCH_SELECTORS = ['[data-slot="composer-surface"]', '[data-slot="profile-rail"]']

// A full-width bar pinned to the window bottom (the status bar). When present,
// the pet walks along its TOP edge instead of the window edge, so it stands on
// the bar rather than covering it. Not mounted on mobile — there the bottom of
// the walk box comes from the safe area instead.
const FLOOR_BAR_SELECTOR = '[data-slot="statusbar"]'

const vw = (): number => window.innerWidth || 800
const vh = (): number => window.innerHeight || 600

// Resolve the `--titlebar-height` CSS var to px (it's authored in rem).
function titlebarHeightPx(): number {
  const root = getComputedStyle(document.documentElement)
  const raw = root.getPropertyValue('--titlebar-height').trim()
  const rem = parseFloat(root.fontSize) || 16

  if (raw.endsWith('rem')) {
    return (parseFloat(raw) || 0) * rem
  }

  return parseFloat(raw) || 36
}

/** The bottom ground line: the top of the status bar if it's pinned full-width
 *  across the window bottom, otherwise the window edge. */
function floorY(width: number, height: number, petH: number): number {
  const bar = document.querySelector(FLOOR_BAR_SELECTOR)

  if (bar) {
    const rect = bar.getBoundingClientRect()

    if (rect.width >= width * 0.5 && height - rect.bottom < 4 && rect.top - petH >= 0) {
      return rect.top
    }
  }

  return height
}

/**
 * The area the pet may occupy.
 *
 * On a phone this is inset by the safe area, which is the fix for the pet
 * standing on the home indicator and sitting under the notch — the old code
 * used raw `window.innerHeight`, and the status bar it used to stand on isn't
 * mounted on mobile at all, so nothing was holding it up.
 *
 * The keyboard is subtracted from the bottom as well. The pet is
 * `position: fixed`, so `--keyboard-inset` (which the mobile shell applies as a
 * margin) does not lift it the way it lifts everything else — it would simply
 * end up behind the keyboard.
 */
export function walkBox(petH: number, safeArea: boolean): WalkBox {
  const width = vw()
  const height = vh()

  if (!safeArea) {
    return { bottom: floorY(width, height, petH), left: 0, right: width, top: 0 }
  }

  const insets = readSafeAreaInsets()
  const keyboard = readKeyboardInset()
  const bottom = Math.max(insets.top + petH, height - insets.bottom - keyboard)

  return { bottom, left: insets.left, right: Math.max(insets.left, width - insets.right), top: insets.top }
}

/**
 * Snapshot the walkable surfaces right now: the box edges plus any on-screen
 * perch element with room above it. Perches are always `floor`-oriented — a
 * composer top is a ledge you stand on, whichever walls are in play — which is
 * why they need no special handling in a wall-walking world.
 */
export function snapshotSurfaces(petW: number, petH: number, opts: { safeArea: boolean; walls: boolean }): Surface[] {
  const box = walkBox(petH, opts.safeArea)
  const surfaces = surfacesFromBox(box, petW, petH, opts.walls)
  const height = vh()

  for (const selector of PERCH_SELECTORS) {
    const el = document.querySelector(selector)

    if (!el) {
      continue
    }

    const rect = el.getBoundingClientRect()
    const from = Math.max(box.left, rect.left)
    const to = Math.min(box.right - petW, rect.right - petW)

    // Skip surfaces that are too narrow for the pet, have no headroom above, or
    // sit off-screen / flush with the floor (no daylight between them).
    if (to <= from + 2 || rect.top - petH < box.top || rect.top > height - 8 || height - rect.top < 12) {
      continue
    }

    surfaces.push({ from, pos: rect.top, to, wall: 'floor' })
  }

  return surfaces
}

/**
 * While a full-screen route overlay is up it's the only walkable surface: a
 * single ledge at the overlay card's bottom inner edge. The card uses
 * `OverlayView`'s equal inset on every side — `titlebar-height + padding` — so
 * we derive it from that rather than measuring.
 */
export function overlaySurface(petW: number): Surface {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const inset = titlebarHeightPx() + (vw() >= 640 ? 0.875 : 0.625) * rem

  return { from: inset, pos: vh() - inset, to: Math.max(0, vw() - inset - petW), wall: 'floor' }
}
