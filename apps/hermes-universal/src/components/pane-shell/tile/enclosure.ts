/**
 * ENCLOSURE — the CONTAINER half of "is this on screen?".
 *
 * `tile/visibility.ts` answers it for a tile: registered? revealed? collapsible
 * at this width? Enclosure answers it for the zone a tile sits in, and the two
 * are deliberately separate functions rather than one:
 *
 *   - a tile-level rule needs an ID. `tileVisibility('files', ctx)`.
 *   - a container-level rule needs the TREE. "Is this child on the collapsed
 *     side of the root row?" cannot be asked of an id — the answer depends on
 *     where the id currently sits, which only the split renderer knows.
 *
 * Folding side-collapse into `tileVisibility` would ALSO change what
 * `subtreeGone` and `fixedTrackSize` see, and those drive track sizing — a
 * collapsed side would start reporting flex tracks. That is a sizing change
 * wearing a refactor's clothes, so the two rules stay named and separate.
 *
 * What this file replaces is four inline lambdas in `tree-split.tsx`
 * (`isEmptyZone`, `isCollapsed`, `isMinimized`, `sideGone`) that between them
 * expressed three different notions of "not showing" and were combined by hand
 * at each read.
 */

import { allPaneIds, type LayoutNode } from '../tree/model'
import { rootChildSide, subtreeFolded, subtreeGone, type TrackContext } from '../tree/renderer/track-model'
import type { TreeSide } from '../tree/store'

import type { Tile, TileId } from './types'

export interface EnclosureContext extends TrackContext {
  /** Sides of the root row the titlebar toggles (⌘B / ⌘J) have closed. */
  collapsedSides: ReadonlySet<TreeSide>
  /** Only the ROOT row owns semantic sides — see `semantic` below. */
  rootRow: boolean
  /** Layout-edit mode keeps sides visible so they can be rearranged. */
  editMode: boolean
  /** Below the sidebar-collapse breakpoint. */
  narrow: boolean
  /** The REVEAL axis, to tell a narrow-collapse from a chrome-toggle hide. */
  hidden: ReadonlySet<string>
  tileFor: (id: TileId) => Tile | undefined
}

/**
 * How a split's child is enclosed.
 *
 *  - `collapsed`  — renders `display:none`; content stays MOUNTED, so toggling
 *                   back is instant. Its siblings absorb the space.
 *  - `minimized`  — renders as its own strip (a rail in a row, a header in a
 *                   column). Distinct from collapsed: a minimized zone is still
 *                   on screen and is its own restore affordance.
 *  - `narrowCollapsed` — collapsed AND the breakpoint did it, not a toggle. The
 *                   edge overlay owns the single live instance of the content,
 *                   so this one UNMOUNTS.
 */
export interface ZoneEnclosure {
  collapsed: boolean
  minimized: boolean
  narrowCollapsed: boolean
}

/**
 * SEMANTIC side collapse (titlebar toggles / ⌘B / ⌘J): at the root row, ⌘B owns
 * the sessions column and ⌘J the other side columns — by tile PLACEMENT, not
 * position, so a ⌘\ flip moves the columns without rewiring the toggles. In
 * edit mode sides stay visible.
 */
const semanticSides = (ctx: EnclosureContext, horizontal: boolean): boolean =>
  ctx.rootRow && horizontal && ctx.collapsedSides.size > 0 && !ctx.editMode

const sideGone = (child: LayoutNode, ctx: EnclosureContext, horizontal: boolean): boolean => {
  if (!semanticSides(ctx, horizontal)) {
    return false
  }

  const side = rootChildSide(child, ctx.paneFor)

  return side !== null && ctx.collapsedSides.has(side)
}

/** EMPTY zones only exist in editor-authored trees (`normalize` prunes them on
 *  every structural op) — they take space in edit mode as drop targets. */
const isEmptyZone = (child: LayoutNode): boolean => child.type === 'group' && child.panes.length === 0

export function zoneEnclosure(child: LayoutNode, ctx: EnclosureContext, horizontal: boolean): ZoneEnclosure {
  const collapsed = subtreeGone(child, ctx) || (isEmptyZone(child) && !ctx.editMode) || sideGone(child, ctx, horizontal)

  return {
    collapsed,
    // A SPLIT whose every visible zone is minimized is itself a strip (the
    // cascading fold) — `subtreeFolded` subsumes the plain `group.minimized`
    // check, so a folded split takes the minimized branch everywhere below.
    minimized: subtreeFolded(child, ctx),
    // Only for tiles the BREAKPOINT collapsed, not ones a chrome toggle hid —
    // unmounting a toggle-hidden tile would throw away state the toggle
    // promises to bring straight back.
    narrowCollapsed: ctx.narrow && collapsed && allPaneIds(child).some(id => !ctx.hidden.has(id))
  }
}
