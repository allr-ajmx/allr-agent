/**
 * Layout tree renderer (root).
 *
 * - `split` -> flex row/column; 1px seams between siblings double as resize
 *   sashes (the seam IS the boundary — junction-owned, never doubled). See
 *   tree-split.tsx.
 * - `group` -> a ZONE: header strip (tabs when stacked, minimize chevron) +
 *   the active pane's content, resolved from the contribution registry
 *   (`area: 'panes'`). Empty zones exist only in editor-authored trees. See
 *   tree-group.tsx.
 *
 * Dragging is FancyZones-style (drag-session.ts): the LAYOUT STAYS FIXED and
 * every zone lights up as a whole-region drop target; dropping moves the pane
 * into that zone (joining its tab stack). Structure changes (splitting/merging/
 * resizing zones) belong to the zone editor, not the drag.
 *
 * This file owns only the composition: the recursive tree, the narrow-viewport
 * overlays, the edit palette, and the zone editor. The pieces live in sibling
 * modules — track-model (sizing), drag-session (drag), tree-split / tree-group
 * (nodes), narrow-overlays, edit-bar / layout-picker / zone-editor (authoring).
 */

import { useStore } from '@nanostores/react'
import { Profiler, type ReactNode, useEffect } from 'react'

import { DEV_TOOLS_ENABLED } from '@/observability/enabled'

import { useLayoutEditHotkey } from '../../edit-mode'
import { publishWorkspaceGeometry } from '../../geometry'
import { watchDetachedTileWindows } from '../../tile/detach'
import { $layoutTree, trackActiveTreeGroup } from '../store'
import { ZoneEditor } from '../zone-editor'

import { TreeEditBar } from './edit-bar'
import { FloatingTiles } from './floating-panes'
import { NarrowOverlays } from './narrow-overlays'
import { notifyReactCommit } from './telemetry'
import { TreeNode } from './tree-node'

export function LayoutTreeRoot({ children }: { children?: ReactNode }) {
  const tree = useStore($layoutTree)

  useLayoutEditHotkey(true)
  // Track the interacted zone so ⌘W closes the right tab even when nothing is
  // DOM-focused.
  useEffect(trackActiveTreeGroup, [])
  // Reattach a detached tile when its window goes away — by the ✕, the window
  // menu, or the compositor. Mounted HERE because this root only ever renders in
  // the primary window; a tile window bypasses it (see app.tsx).
  useEffect(watchDetachedTileWindows, [])
  // Publish --workspace-left/right so chrome (titlebar title) aligns to the
  // main pane's geometry in plain CSS.
  useEffect(publishWorkspaceGeometry, [])

  if (!tree) {
    return null
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* ZonesOverlay::GetAnimationAlpha ramp: clamp(t / 200ms, 0.001, 1). */}
      <style>{`@keyframes hermes-zone-fade { from { opacity: 0.001 } to { opacity: 1 } }`}</style>
      {/* THE SEAM INVARIANT: boundaries are drawn by the tree (one sash
          hairline per seam) — content mounted in a zone must not paint its
          own edge chrome. App components (asides, the shadcn sidebar) carry
          edge borders + inset highlights for the OLD shell's geometry; this
          neutralizes all of them at the zone boundary, for every current and
          future pane, instead of per-pane class surgery. */}
      <style>{`
        [data-tree-group] :is(aside, [data-slot=sidebar]) {
          border-left-width: 0;
          border-right-width: 0;
          box-shadow: none;
        }
        /* Old-shell titlebar BANDS (chat's session header et al size to
           --titlebar-height, which is 0 inside zones): a zero-height band is
           non-functional but still paints its border-b — a stray hairline
           doubling the zone's top seam. Remove the band entirely. */
        [data-tree-group] header[class*="h-(--titlebar-height)"] {
          display: none;
        }
      `}</style>
      {/* The React commit is the measurement that adjudicates "is the layout
          tree re-rendering more than it needs to" — the question MJXHRM-139
          answered by hand (109 commits / 2565ms in a 9-second drag) and nobody
          could ask again without repeating the work. Dev/bench only: Profiler
          adds per-commit timing to its whole subtree, so it must not ship. */}
      {DEV_TOOLS_ENABLED ? (
        <Profiler id="layout-tree" onRender={notifyReactCommit}>
          <TreeNode node={tree} root rootRow={tree.type === 'split' && tree.orientation === 'row'} />
        </Profiler>
      ) : (
        <TreeNode node={tree} root rootRow={tree.type === 'split' && tree.orientation === 'row'} />
      )}
      <NarrowOverlays />
      {/* The non-tiling placement: `placement: 'floating'` tiles render as fixed
          cards ABOVE the tree instead of taking width from a zone. Renders
          nothing until a tile declares it. */}
      <FloatingTiles />
      {/* Structural authoring: the floating palette (edit mode) and the grid
          editor it opens. Both render nothing until their store says so. */}
      <TreeEditBar />
      <ZoneEditor />
      {children}
    </div>
  )
}
