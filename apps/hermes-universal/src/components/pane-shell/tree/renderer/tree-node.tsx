import type { LayoutNode, Orientation } from '../model'

import { TreeGroup } from './tree-group'
import { TreeSplit } from './tree-split'

/** Inside a CASCADING FOLD (a split whose every visible zone is minimized, so
 *  the split itself renders as one strip): the descendants must pick their
 *  strip form from the OUTER fold axis, not their literal parent orientation —
 *  a column folded inside a row is a vertical rail, however its own children
 *  are stacked. `railSide` is the folded stack's side of that row, inherited by
 *  every zone in it so their divider strokes agree. */
export interface FoldContext {
  axis: Orientation
  railSide?: 'left' | 'right'
}

/** Dispatch a layout node to its renderer — the split/group recursion point.
 *  `root` marks the tree's top split (side collapse applies only there).
 *  `rootRow` marks the row split that owns the side columns — usually the root
 *  itself, but in a column-root layout (Terminal deck, Quad) it's the row
 *  child holding sessions/workspace/files. Side collapse (⌘B/⌘J) applies here.
 *  `parentAxis` is the containing split's orientation — a group collapses
 *  ALONG that axis, so it picks the minimized form (row → vertical rail,
 *  column → horizontal header). `railSide` is which half of that row the
 *  child sits in — the rail's divider stroke faces the content side. */
export function TreeNode({
  folded,
  node,
  parentAxis,
  railSide,
  root,
  rootRow
}: {
  folded?: FoldContext
  node: LayoutNode
  parentAxis?: 'column' | 'row'
  railSide?: 'left' | 'right'
  root?: boolean
  rootRow?: boolean
}) {
  return node.type === 'split' ? (
    <TreeSplit folded={folded} node={node} root={root} rootRow={rootRow} />
  ) : (
    <TreeGroup foldAxis={folded?.axis} node={node} parentAxis={parentAxis} railSide={folded?.railSide ?? railSide} />
  )
}
