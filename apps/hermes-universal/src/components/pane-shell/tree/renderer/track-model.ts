/**
 * The TRACK MODEL — how a layout node resolves its size along a split axis.
 *
 * A node is a FIXED track when it resolves to a CSS length (sidebars keep
 * their declared size) and a FLEX track when it doesn't (weight-shared
 * leftover). Everything here is pure geometry over the layout tree + the
 * live pane contributions; the React split renderer reads it per render.
 */

import { cssMax, tileAxisLength } from '../../tile/sizing'
import type { Tile } from '../../tile/types'
import type { GroupNode, LayoutNode } from '../model'
import { allPaneIds } from '../model'

export const MIN_PANE_PX = 80

/** Resolve a computed style length ("237px" / "none" / "auto") to px. */
export function computedPx(value: string, fallback: number): number {
  const n = Number.parseFloat(value)

  return Number.isFinite(n) ? n : fallback
}

/** Resolve an AUTHORED CSS length ("237px", "38vh", "clamp(18rem,36vw,32rem)")
 *  to px by measuring a probe inside `container` — handles every unit and
 *  math function the browser does. */
export function resolveCssPx(container: HTMLElement, css: number | string, horizontal: boolean): number | null {
  if (typeof css === 'number') {
    return css
  }

  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'

  if (horizontal) {
    probe.style.width = css
  } else {
    probe.style.height = css
  }

  container.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  const px = horizontal ? rect.width : rect.height

  return Number.isFinite(px) && px > 0 ? px : null
}

/** Everything fixed-track resolution needs about the current view state. */
export interface TrackContext {
  paneFor: (id: string) => Tile | undefined
  paneGone: (id: string) => boolean
  overrides: Record<string, { widthOverride?: number; heightOverride?: number }>
}

/** A group's panes that are actually on screen (not hidden / narrow-collapsed
 *  / unregistered). The one place the "shown" filter lives. */
export const shownPaneIds = (group: GroupNode, ctx: TrackContext): string[] =>
  group.panes.filter(id => !ctx.paneGone(id))

/**
 * THE TRACK MODEL. A node's size along `axis` is FIXED when it resolves to a
 * CSS length, and FLEX (weight-shared leftover) when null:
 *
 *  - zone: the max() of its shown panes' declared `width`/`height` (a live px
 *    override from a sash drag wins) — sidebars keep their size, main flexes,
 *    and the zone never resizes when tabs switch or a drop fronts a pane.
 *  - split ALONG the axis: the sum of its visible children — fixed only when
 *    every child is (one flex child makes the run flex).
 *  - split ACROSS the axis: the max of its visible fixed children (flex
 *    children just stretch to the container); flex only when none are fixed.
 *
 * This is how "two right sidebars over a terminal row" sizes itself from its
 * content (237px, or 474px when review is visible) instead of taking a
 * fraction of the window.
 */
/** A minimized zone IS its strip: the vertical rail (row) / header (column)
 *  are both 28px thick. */
export const MINIMIZED_TRACK = '1.75rem'

export function fixedTrackSize(node: LayoutNode, axis: 'row' | 'column', ctx: TrackContext): string | null {
  if (node.type === 'group') {
    // Ancestor splits must size a minimized zone as its strip, not as its
    // panes' declared widths — otherwise the outer track keeps reserving the
    // full sidebar width and the collapsed rail floats in a dead column.
    if (node.minimized) {
      return MINIMIZED_TRACK
    }

    const overrideKey = axis === 'row' ? 'widthOverride' : 'heightOverride'
    const declared = (id: string) => tileAxisLength(ctx.paneFor(id), axis, ctx.overrides[id]?.[overrideKey])

    // Which zones are FIXED tracks:
    //  - a MAIN-bearing zone (workspace/tile stacked in) is flex-at-heart —
    //    mixing a sidebar pane into it (files fronted in the Focus mono-stack)
    //    must NOT snap the whole zone to sidebar width;
    //  - any other zone stays fixed as long as SOME tenant declares a size —
    //    dropping a size-less pane (the terminal has height but no width)
    //    into the 237px files sidebar must not balloon it to a flex track.
    const ids = shownPaneIds(node, ctx)
    const sizes = ids.map(declared)
    const declaredSizes = sizes.filter((size): size is string => size !== null)

    if (declaredSizes.length === 0) {
      return null
    }

    if (sizes.length !== declaredSizes.length && ids.some(id => ctx.paneFor(id)?.placement === 'main')) {
      return null
    }

    // A STACK sizes to its LARGEST tenant (CSS max()), never the active tab:
    // dropping a pane into a zone — the drop fronts it — or switching tabs
    // must not resize the container (dropping sessions into a wider fixed
    // zone used to snap the whole zone down to sidebar width).
    return cssMax(declaredSizes) ?? null
  }

  const visible = node.children.filter(child => !subtreeGone(child, ctx))

  const sizes = visible.map(child =>
    // A FOLDED child (a minimized zone, or a split whose every visible zone is
    // minimized — see `subtreeFolded`) is a 1.75rem strip ONLY along the axis
    // it collapsed on (this split's own orientation — its parent axis). ACROSS
    // that axis the strip STRETCHES to fill, so it must report flex (null),
    // NOT a fixed 1.75rem — otherwise an ancestor track (the root row asking
    // this COLUMN for its width) reads the minimized child as fixed-thin and
    // collapses the WHOLE column/row to a rail, dragging every sibling down
    // with it.
    subtreeFolded(child, ctx) ? (node.orientation === axis ? MINIMIZED_TRACK : null) : fixedTrackSize(child, axis, ctx)
  )

  if (node.orientation === axis) {
    if (sizes.length === 0 || sizes.some(size => size === null)) {
      return null
    }

    return sizes.length === 1 ? sizes[0] : `calc(${sizes.join(' + ')})`
  }

  // Across the axis a flex child just stretches; the fixed ones set the size.
  return cssMax(sizes) ?? null
}

/**
 * The CASCADING FOLD: true when this node is collapsed to a strip — either a
 * zone the user minimized, or a split whose every visible zone is folded. A
 * column of three minimized zones is three stacked header strips wasting a
 * whole column, so the split itself folds along its PARENT's axis into one
 * thin rail and the neighbours absorb the freed space. Recurses upward.
 *
 * DERIVED, never stored: no new tree field, so `normalize`/persistence stay
 * untouched and "unfold" is just "a zone inside stopped being minimized".
 * `subtreeFolded(group) === Boolean(group.minimized)`, so it SUBSUMES the old
 * group checks — a folded split then flows through the exact plumbing a
 * minimized zone already uses (MINIMIZED_TRACK, `minimized` enclosure,
 * `flex: 0 0 auto`, disabled sashes).
 *
 * Gone children neither count nor block — the same `subtreeGone` filter
 * `fixedTrackSize` uses above, so the two predicates cannot disagree. An
 * all-gone subtree is `false` and stays `collapsed` via that branch: fold
 * never competes with collapse.
 */
export function subtreeFolded(node: LayoutNode, ctx: TrackContext): boolean {
  if (node.type === 'group') {
    return Boolean(node.minimized)
  }

  const visible = node.children.filter(child => !subtreeGone(child, ctx))

  return visible.length > 0 && visible.every(child => subtreeFolded(child, ctx))
}

/** True when every pane in the subtree is hidden/narrow-collapsed. */
export function subtreeGone(node: LayoutNode, ctx: TrackContext): boolean {
  const ids = allPaneIds(node)

  return ids.length > 0 && ids.every(ctx.paneGone)
}

/**
 * Which chrome toggle owns a root-row child — SEMANTIC, not positional:
 * ⌘B is the sessions/nav column (any `placement: 'left'` pane) wherever a
 * flip or drag puts it; ⌘J is every other side column. `null` = contains
 * the main zone, never side-collapsed. This is what keeps the titlebar
 * toggles and reveals 100% main-compatible through ⌘\ flips.
 */
export function rootChildSide(child: LayoutNode, paneFor: (id: string) => Tile | undefined): 'left' | 'right' | null {
  const placements = allPaneIds(child).map(id => paneFor(id)?.placement)

  if (placements.includes('main')) {
    return null
  }

  return placements.includes('left') ? 'left' : 'right'
}

/**
 * The FIXED zone that owns `edge` of this subtree along `axis` — the zone a
 * sash on that boundary actually resizes (dragging the seam between main and
 * a nested right section resizes the section's edge sidebar, VS Code-style).
 */
export function edgeFixedZone(
  node: LayoutNode,
  edge: 'start' | 'end',
  axis: 'row' | 'column',
  ctx: TrackContext
): GroupNode | null {
  if (node.type === 'group') {
    return fixedTrackSize(node, axis, ctx) !== null ? node : null
  }

  const visible = node.children.filter(child => !subtreeGone(child, ctx))

  if (node.orientation === axis) {
    const child = edge === 'start' ? visible[0] : visible[visible.length - 1]

    return child ? edgeFixedZone(child, edge, axis, ctx) : null
  }

  // Cross-axis: every child touches the edge — the first fixed one owns it.
  for (const child of visible) {
    const zone = edgeFixedZone(child, edge, axis, ctx)

    if (zone) {
      return zone
    }
  }

  return null
}
