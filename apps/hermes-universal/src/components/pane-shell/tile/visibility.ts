/**
 * ONE rule for "is this tile on screen?".
 *
 * It used to be two, written out as mutual negations in two files and kept in
 * sync by eye:
 *
 *   paneShown  tree-group.tsx   Boolean(paneFor(id)) && (editMode || !hidden.has(id)) && !(narrow && collapsible)
 *   paneGone   tree-split.tsx   !paneFor(id) || (!editMode && hidden.has(id)) || (narrow && collapsible)
 *
 * De Morgan says those agree — until someone edits one. That is how a tab strip
 * and the track sizing it drives end up disagreeing about which tiles exist:
 * the zone renders a tab for a tile the split has already collapsed out of the
 * layout, or the split reserves a track for a tile with no tab.
 *
 * (`shownPaneIds` in the track model reads as a third copy but isn't — it
 * filters through whichever predicate its `TrackContext` was handed, so it was
 * always delegating and now inherits the shared rule for free.)
 */

import { type Tile, tileChrome, type TileId } from './types'

/**
 * FOUR outcomes, not a boolean, because the reasons are not interchangeable and
 * callers past this step need to tell them apart:
 *
 *  - `visible`  — in the grid, rendered.
 *  - `hidden`   — its owning store says off (⌘G closed review, the terminal
 *                 toggle). The zone collapses but the content stays mounted
 *                 once the tile has been on screen even once, so toggling back
 *                 is instant. (It was NOT: `keptPanes` filtered `shown`, so
 *                 hiding tore the surface down — MJXHRM-373.)
 *  - `enclosed` — it left the grid because its CONTAINER can't show it at this
 *                 width; it is still reachable, through the edge overlay.
 *  - `absent`   — nothing registered it. A runtime plugin that hasn't loaded.
 *                 There is nothing to show and nothing to reach.
 *
 * MJXHRM-167 folds side-collapse and zone-minimize into `enclosed`; they are
 * properties of the container and resolving them needs the tree rather than an
 * id, so they stay in the split renderer until then. The slot is already here.
 */
export type TileVisibility = 'absent' | 'enclosed' | 'hidden' | 'visible'

export interface TileContext {
  tileFor: (id: TileId) => Tile | undefined
  /** The REVEAL axis — ids their owning store has toggled off. */
  hidden: ReadonlySet<string>
  /** Below the sidebar-collapse breakpoint: collapsible tiles leave the grid. */
  narrow: boolean
  /** Layout-edit mode reinstates `hidden` tiles so they can be rearranged. */
  editMode: boolean
}

export function tileVisibility(id: TileId, ctx: TileContext): TileVisibility {
  const tile = ctx.tileFor(id)

  if (!tile) {
    return 'absent'
  }

  // Enclosure is checked BEFORE reveal, and edit mode deliberately does not
  // reinstate it: at this width there is no grid slot to drag the tile into, so
  // showing it would offer a rearrangement that cannot be committed.
  if (ctx.narrow && tileChrome(tile).collapsible) {
    return 'enclosed'
  }

  if (ctx.hidden.has(id) && !ctx.editMode) {
    return 'hidden'
  }

  return 'visible'
}

/** In the grid right now. The zone renderer's tab filter. */
export const tileShown = (id: TileId, ctx: TileContext): boolean => tileVisibility(id, ctx) === 'visible'

/** Not in the grid, for any reason. The split renderer's collapse test — and
 *  the exact negation of `tileShown`, which is the property the two hand-copied
 *  predicates could only promise by inspection. */
export const tileGone = (id: TileId, ctx: TileContext): boolean => !tileShown(id, ctx)
