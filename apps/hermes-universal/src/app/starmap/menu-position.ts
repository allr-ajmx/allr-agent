// Keeping a canvas-anchored menu on screen.
//
// The star map's node menu is positioned at a raw viewport point, because its
// anchor is a pixel on a canvas rather than a DOM element — so none of Radix's
// collision handling applies and it has to be done here. Without it the menu
// simply runs off the edge: right-half taps clip horizontally, and on a phone,
// where the menu is a large fraction of the screen, nearly every tap in the
// lower half clips vertically too.
//
// Pure, so the geometry is testable without mounting anything.

export interface MenuBox {
  /** Anchor point, in viewport coordinates. */
  x: number
  y: number
  /** Measured menu size. */
  w: number
  h: number
  /** Viewport size. */
  vw: number
  vh: number
  /** Keep-out margin — pass the safe-area insets on a notched device. */
  inset?: { top?: number; right?: number; bottom?: number; left?: number }
}

/**
 * Place the menu at the anchor, flipping to the other side when there isn't
 * room and clamping if it doesn't fit either way.
 *
 * Flip before clamp, deliberately: clamping alone would slide the menu back
 * over the very node the user just pressed, hiding what they targeted. Flipping
 * puts it beside the finger instead. Clamping is the last resort for a menu
 * taller than the space available, where something has to give.
 */
export function clampMenuPosition({ h, inset, vh, vw, w, x, y }: MenuBox): { left: number; top: number } {
  const top = inset?.top ?? 0
  const right = inset?.right ?? 0
  const bottom = inset?.bottom ?? 0
  const left = inset?.left ?? 0

  const minX = left
  const maxX = vw - right - w
  const minY = top
  const maxY = vh - bottom - h

  // Flip to the other side of the anchor when the preferred side won't fit.
  let nextX = x + w > vw - right ? x - w : x
  let nextY = y + h > vh - bottom ? y - h : y

  // Clamp — and only clamp to the min when the range is real, so a menu bigger
  // than the viewport pins to the top-left instead of jumping past it.
  nextX = maxX < minX ? minX : Math.min(Math.max(nextX, minX), maxX)
  nextY = maxY < minY ? minY : Math.min(Math.max(nextY, minY), maxY)

  return { left: nextX, top: nextY }
}
