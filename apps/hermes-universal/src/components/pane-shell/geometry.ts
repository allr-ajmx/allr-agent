/**
 * Pane geometry — publishes the MAIN zone's viewport edges as CSS vars, so
 * chrome that aligns to it (the titlebar title et al) reads
 * `var(--workspace-left/right)` in plain CSS instead of threading rects through
 * React.
 *
 * This file used to also carry a window-controls-overlap system: an AABB
 * `intersect()` against the native window controls (macOS traffic lights /
 * Windows-WSLg overlay), a `useWindowControlsRect` store and a
 * `useWindowControlsOverlap` hook every zone called. All of it was gated on
 * `'hermesDesktop' in window` — an ELECTRON global. Universal is Tauri and
 * draws its own titlebar controls, so the gate was never true, the rect was
 * always null, the overlap was always null, and the JSX it guarded never
 * rendered. It cost a `useSyncExternalStore` (with a window resize listener), a
 * `useState` and a `useLayoutEffect` per zone, per render, to compute nothing.
 *
 * Deleted rather than left for later: if universal ever adopts native window
 * decorations, the honest version reads a Tauri window-controls rect, and none
 * of the Electron-shaped code above would have been reusable anyway.
 */

import { $layoutTree } from '@/components/pane-shell/tree/store'
import { onResizeGestureEnd, resizeGestureActive } from '@/lib/resize-gesture'

import { queryVisible } from './pane-visibility'

// ---------------------------------------------------------------------------
// Workspace-edge CSS vars
// ---------------------------------------------------------------------------

// --- Resize deferral ---------------------------------------------------------
//
// While a resize gesture runs, `publishWorkspaceGeometry` skips its `:root`
// custom property writes: each one invalidates computed style for the WHOLE
// document, and the ResizeObserver below fires every frame of a drag. The vars
// only align titlebar chrome, so republishing once at the end is visually
// identical.
//
// The gesture itself lives in `lib/resize-gesture.ts` — this file owned the
// depth counter back when the sash was the only thing that opened one. It now
// also covers an OS window-edge drag, which used to write both vars on every
// resize event.

/**
 * Publish the workspace zone's viewport edges as root CSS vars:
 *   --workspace-left  : px from the viewport's left to the main zone
 *   --workspace-right : px from the main zone's right to the viewport's right
 *
 * Measured once per relevant change (zone resize via ResizeObserver, layout
 * mutations via $layoutTree, window resize) and consumed in plain CSS — the
 * measured-var idiom (--composer-measured-height), not per-component JS
 * geometry. Call once from the tree root; returns the disposer.
 */
export function publishWorkspaceGeometry(): () => void {
  const root = document.documentElement
  let el: HTMLElement | null = null
  let lastLeft = NaN
  let lastRight = NaN

  const ro = new ResizeObserver(() => measure())

  const measure = () => {
    // DEFERRED during a resize gesture (see above) — republished once at the
    // end via the onResizeGestureEnd hook registered below.
    if (resizeGestureActive()) {
      return
    }

    const next = queryVisible<HTMLElement>('[data-session-anchor="workspace"]')

    if (next !== el) {
      if (el) {
        ro.unobserve(el)
      }

      el = next

      if (el) {
        ro.observe(el)
      }
    }

    if (!el) {
      return
    }

    const r = el.getBoundingClientRect()
    const left = Math.round(r.left)
    const right = Math.round(window.innerWidth - r.right)

    // Skip unchanged writes: a sash drag fires the RO every frame, and each
    // :root custom-property set dirties style for everything that reads them.
    if (left !== lastLeft) {
      lastLeft = left
      root.style.setProperty('--workspace-left', `${left}px`)
    }

    if (right !== lastRight) {
      lastRight = right
      root.style.setProperty('--workspace-right', `${right}px`)
    }
  }

  // Tree mutations move zones without resizing them (⌘\ flip) — re-measure a
  // frame later, after the DOM committed. RO covers width changes (sash drags,
  // side collapses); window resize covers the rest.
  const unsubTree = $layoutTree.listen(() => requestAnimationFrame(measure))
  // Gesture over -> publish the final geometry the deferral above skipped. A
  // frame later, so the DOM has committed the release's own store write.
  const unsubGesture = onResizeGestureEnd(() => requestAnimationFrame(measure))
  window.addEventListener('resize', measure)
  measure()

  return () => {
    unsubTree()
    unsubGesture()
    window.removeEventListener('resize', measure)
    ro.disconnect()
    root.style.removeProperty('--workspace-left')
    root.style.removeProperty('--workspace-right')
  }
}
