// Reading direction, for the places CSS cannot reach.
//
// Logical properties (`inset-inline-start`, `margin-inline-*`) mirror a layout
// for free, but a pointer drag is raw physical geometry: `clientX` grows to the
// RIGHT in every locale. A sash that renders on the correct edge under `dir=rtl`
// but widens the pane when you drag it inward is worse than one that never
// moved, so every x-axis drag multiplies its delta by this sign.
//
// Read from computed style, not from `document.documentElement.dir`, so a handle
// inside a deliberately LTR-pinned subtree (code, diffs, the terminal — see the
// `[dir='rtl']` block in styles.css) reports the direction it is actually laid
// out in rather than the document's.

/** `-1` when `el` is laid out right-to-left, `1` otherwise. */
export function directionSign(el: Element | null | undefined): 1 | -1 {
  if (!el || typeof window === 'undefined') {
    return 1
  }

  return window.getComputedStyle(el).direction === 'rtl' ? -1 : 1
}
