/**
 * The SHAPE of a layout tree, computed analytically — how much work rendering
 * it costs, without instrumenting the code that does the rendering.
 *
 * WHY NOT COUNT THE CALLS
 *
 * The obvious instrument is a counter inside `fixedTrackSize` / `subtreeGone` /
 * `allPaneIds`. It is the wrong place twice over:
 *
 *  - `tree/model.ts` and `renderer/track-model.ts` are pure, have no imports
 *    worth speaking of, and are unit-tested. An observability import into them
 *    makes those tests depend on the tracer forever.
 *  - `allPaneIds` is called by the drag session, the tab verbs and the store as
 *    well as by render. A counter there totals a superset with no way to say
 *    which part came from the render path — a number that cannot be attributed
 *    is not evidence.
 *
 * `paneVisits` is the one that matters. `fixedTrackSize` filters its children
 * through `subtreeGone`, which walks the whole subtree via `allPaneIds`, and
 * then recurses and does it again one level down — so a full tracks pass costs
 * the sum, over every split, of that split's subtree pane count. That is
 * O(n·depth) and it is computed here directly rather than observed.
 *
 * The payoff over raw counters: this yields `n` as well as the work, so
 * "340 pane visits" can be read against "9 panes" instead of floating free.
 *
 * SHIPS, because `tree/store.ts` attaches it to `layout.commit` — but it is
 * only ever CALLED behind `isRecording()`. A pure tree walk with no imports is
 * a cheap thing to carry; running one on every commit in release would not be.
 */

import type { LayoutNode } from '@/components/pane-shell/tree/model'
import type { SpanAttrs } from '@/observability'

export interface TreeShape {
  /** Deepest split nesting. */
  depth: number
  groups: number
  /** Distinct panes in the tree. */
  panes: number
  /** What one full tracks pass costs in `allPaneIds` node visits. */
  paneVisits: number
  splits: number
}

export function treeShape(node: LayoutNode | null): TreeShape {
  const shape: TreeShape = { depth: 0, groups: 0, panes: 0, paneVisits: 0, splits: 0 }

  if (!node) {
    return shape
  }

  // Returns the subtree's pane count so the parent can bill itself for the walk
  // it would do over exactly these panes.
  const walk = (current: LayoutNode, depth: number): number => {
    shape.depth = Math.max(shape.depth, depth)

    if (current.type === 'group') {
      shape.groups += 1
      shape.panes += current.panes.length

      return current.panes.length
    }

    shape.splits += 1

    let panes = 0

    for (const child of current.children) {
      panes += walk(child, depth + 1)
    }

    shape.paneVisits += panes

    return panes
  }

  walk(node, 0)

  return shape
}

/** `treeShape` flattened into span attributes, prefixed so it reads as one
 *  group in Jaeger's tag list rather than five unrelated numbers. */
export function shapeAttrs(node: LayoutNode | null): SpanAttrs {
  const shape = treeShape(node)

  return {
    treeDepth: shape.depth,
    treeGroups: shape.groups,
    treePaneVisits: shape.paneVisits,
    treePanes: shape.panes,
    treeSplits: shape.splits
  }
}
