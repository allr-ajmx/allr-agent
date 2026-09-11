/**
 * Split node renderer — a flex row/column whose 1px seams double as resize
 * sashes (the seam IS the boundary — junction-owned, never doubled). Sizing
 * is the TRACK MODEL (track-model.ts): fixed tracks keep their declared size,
 * flex tracks share the leftover by weight, and an all-fixed run lets its
 * last track absorb the slack (VS Code style).
 */

import { useStore } from '@nanostores/react'
import { type PointerEvent as ReactPointerEvent, useCallback, useMemo, useRef, useSyncExternalStore } from 'react'

import { directionSign } from '@/lib/direction'
import { guardGuestPointers } from '@/lib/guest-pointer-guard'
import { rafCoalesce } from '@/lib/raf-coalesce'
import { beginResizeGesture, endResizeGesture } from '@/lib/resize-gesture'
import { cn } from '@/lib/utils'
import { $paneStates, type PaneStateSnapshot, setPaneHeightOverride, setPaneWidthOverride } from '@/store/panes'

import { $layoutEditMode } from '../../edit-mode'
import { type EnclosureContext, zoneEnclosure } from '../../tile/enclosure'
import { useTileMap } from '../../tile/registry'
import { tileAxisLength, tileClamps } from '../../tile/sizing'
import type { TileSizing } from '../../tile/types'
import { type TileContext, tileGone } from '../../tile/visibility'
import type { LayoutNode, SplitNode } from '../model'
import { allPaneIds } from '../model'
import {
  $collapsedTreeSides,
  $hiddenTreePanes,
  $narrowViewport,
  persistTree,
  presetSplitWeights,
  setTreeSplitWeights
} from '../store'

import { notifySplitRender } from './telemetry'
import {
  computedPx,
  edgeFixedZone,
  fixedTrackSize,
  MIN_PANE_PX,
  previewGrow,
  resolveCssPx,
  shownPaneIds,
  type TrackContext
} from './track-model'
import { type FoldContext, TreeNode } from './tree-node'

/**
 * The size overrides for a fixed set of panes, referentially stable until one
 * of THEM changes. Sash drags churn `$paneStates` every frame; subscribing the
 * whole map would re-render every split — this narrows each split to its own
 * subtree via a signature-gated snapshot.
 */
function useSubtreeOverrides(paneIds: readonly string[]): TrackContext['overrides'] {
  const key = paneIds.join(',')
  const cache = useRef<{ sig: string; value: Record<string, PaneStateSnapshot> }>({ sig: '\0', value: {} })

  const snapshot = useCallback(() => {
    const all = $paneStates.get()
    const sig = paneIds.map(id => `${id}:${all[id]?.widthOverride ?? ''}:${all[id]?.heightOverride ?? ''}`).join('|')

    if (cache.current.sig !== sig) {
      cache.current = { sig, value: Object.fromEntries(paneIds.flatMap(id => (all[id] ? [[id, all[id]]] : []))) }
    }

    return cache.current.value
    // `key` (the joined ids) stands in for `paneIds`, which is a fresh array
    // every render. Depending on the array itself would hand
    // `useSyncExternalStore` a new getSnapshot each render and defeat the
    // signature gate this whole hook exists to provide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useSyncExternalStore(cb => $paneStates.listen(cb), snapshot, snapshot)
}

export function TreeSplit({
  folded,
  node,
  root,
  rootRow
}: {
  folded?: FoldContext
  node: SplitNode
  root?: boolean
  rootRow?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const byId = useTileMap()
  const hiddenPanes = useStore($hiddenTreePanes)
  const narrow = useStore($narrowViewport)
  const subtreePanes = useMemo(() => allPaneIds(node), [node])
  // Scoped to THIS subtree's panes: a sash drag writes size overrides on every
  // pointermove, but only the splits whose subtree actually resized should
  // re-render — not every split in the tree.
  const overrides = useSubtreeOverrides(subtreePanes)
  const editMode = useStore($layoutEditMode)
  const collapsedSides = useStore($collapsedTreeSides)
  // Inside a fold this split IS a strip, so it lays its (all-minimized) zones
  // out along the OUTER fold axis — a folded column inside a row stacks its
  // rails vertically, i.e. across the fold. `axis` stays the literal
  // orientation for the track context: every child hits the minimized branch
  // while folded, so it is inert there.
  const horizontal = folded ? folded.axis === 'column' : node.orientation === 'row'
  const axis = node.orientation

  // When the root is a column (Terminal deck, Quad), the root ROW — the one
  // the side-collapse system operates on — is a row child containing main.
  // Propagate `rootRow` to that child so its `semanticSides` fires.
  const childRootRow = (child: LayoutNode): boolean => {
    if (!root || horizontal) {
      return false
    }

    if (child.type !== 'split' || child.orientation !== 'row') {
      return false
    }

    return allPaneIds(child).some(id => paneFor(id)?.placement === 'main')
  }

  // A pane leaves the grid when its contribution isn't registered (yet) — a
  // runtime plugin's pane collapses until the plugin loads, then appears; no
  // placeholder flash — when a chrome toggle hides it, or when the viewport
  // is narrow and the pane is collapsible (edge overlay instead).
  const paneFor = (id: string) => byId.get(id)

  // Layout-edit mode forces toggle-hidden panes (terminal off, review/preview
  // closed) visible so they're rearrangeable — only truly-absent (unregistered)
  // or narrow-collapsed panes stay gone. Restores itself on exit (render-only).
  // Same rule the zone renderer's tab filter uses — see tile/visibility.ts.
  const tileCtx: TileContext = { editMode, hidden: hiddenPanes, narrow, tileFor: paneFor }
  const paneGone = (id: string) => tileGone(id, tileCtx)

  const trackCtx: TrackContext = { paneFor, paneGone, overrides }

  // Chrome-toggle collapse, side collapse, minimize and narrow-collapse are one
  // question about the CONTAINER — see tile/enclosure.ts for why it is a
  // separate resolver from the tile-level one rather than folded into it.
  const enclosureCtx: EnclosureContext = {
    ...trackCtx,
    collapsedSides,
    editMode,
    hidden: hiddenPanes,
    narrow,
    rootRow: Boolean(rootRow),
    tileFor: paneFor
  }

  // Min/max clamps come from a direct GROUP child's panes (the same clamps the
  // app's Pane props express), aggregated with largest-tenant semantics that
  // mirror the max() track basis — the active tab's clamps must never resize
  // the zone.
  //
  // A multi-pane FLEX zone used to bail out here and get no clamps at all, so
  // that a sidebar pane fronted in a mixed flex stack could not cap it. But
  // `tileClamps` already guarantees exactly that — a cap survives only when
  // EVERY tenant declares one, so a single uncapped tenant uncaps the zone —
  // and the bail also threw away the FLOOR, which is why a chat zone with two
  // tabs could be crushed to a sliver despite its panes declaring `minWidth`.
  const sizingFor = (child: LayoutNode): TileSizing | null => {
    if (child.type !== 'group' || child.panes.length === 0) {
      return null
    }

    const shownIds = shownPaneIds(child, trackCtx)

    if (shownIds.length <= 1) {
      return paneFor(shownIds[0])?.sizing ?? null
    }

    return tileClamps(shownIds.map(paneFor))
  }

  // Sashes pair each visible child with its nearest visible PREVIOUS sibling
  // (`aIndex`/`bIndex`), not blindly `i-1`/`i` — a collapsed zone in between
  // (e.g. the closed preview pane parked between main and the right rail)
  // must not swallow the seam its visible neighbors share.
  const startSash = useCallback(
    (aIndex: number, bIndex: number, e: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current

      if (!container || e.button !== 0) {
        return
      }

      e.preventDefault()

      const handle = e.currentTarget
      const { pointerId } = e
      const rect = container.getBoundingClientRect()
      const totalPx = horizontal ? rect.width : rect.height
      const totalWeight = node.weights.reduce((a, b) => a + b, 0) || 1
      const pxPerWeight = totalPx / totalWeight
      const start = horizontal ? e.clientX : e.clientY
      const restoreCursor = document.body.style.cursor
      const restoreSelect = document.body.style.userSelect

      // Each side of the seam resolves to a RESIZE TARGET: a fixed zone (the
      // sash writes its px override — sidebar semantics) or the flex run
      // (the sash writes weights). Sizes/clamps read from the live DOM of
      // whichever element actually owns the boundary.
      const sizeOf = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()

        return horizontal ? r.width : r.height
      }

      const sideFor = (child: LayoutNode, wrapper: HTMLElement, edge: 'start' | 'end') => {
        const fixed = fixedTrackSize(child, axis, trackCtx) !== null
        const zone = fixed ? edgeFixedZone(child, edge, axis, trackCtx) : null
        const zoneEl = zone ? container.querySelector<HTMLElement>(`[data-tree-group="${zone.id}"]`) : null
        // Clamps live on the zone's split-child WRAPPER (where we render them).
        const el = zoneEl?.parentElement ?? wrapper
        const cs = window.getComputedStyle(el)

        return {
          // EVERY shown pane of the zone: the zone's track is the max() of its
          // panes' sizes, so the sash writes the same px to all of them —
          // writing only the active pane would leave the zone pinned at a
          // larger sibling's width.
          paneIds: zone ? shownPaneIds(zone, trackCtx) : [],
          fixed: Boolean(zone),
          size: sizeOf(zoneEl ?? wrapper),
          min: Math.max(MIN_PANE_PX, computedPx(horizontal ? cs.minWidth : cs.minHeight, 0)),
          max: computedPx(horizontal ? cs.maxWidth : cs.maxHeight, Number.POSITIVE_INFINITY)
        }
      }

      const kidA = container.children[aIndex] as HTMLElement | undefined
      const kidB = container.children[bIndex] as HTMLElement | undefined

      if (!kidA || !kidB) {
        return
      }

      const a = sideFor(node.children[aIndex], kidA, 'end')
      const b = sideFor(node.children[bIndex], kidB, 'start')
      const a0px = a.fixed ? a.size : sizeOf(kidA)
      const b0px = b.fixed ? b.size : sizeOf(kidB)
      const lo = Math.max(a.min - a0px, b0px - b.max)
      const hi = Math.min(a.max - a0px, b0px - b.min)

      const setOverride = horizontal ? setPaneWidthOverride : setPaneHeightOverride

      try {
        handle.setPointerCapture?.(pointerId)
      } catch {
        // Synthetic events.
      }

      document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      // An iframe guest must not swallow the gesture: it hit-tests on its own,
      // so the drag froze the moment the pointer crossed an artifact preview or
      // a transcript embed and the seam could only move a few px per press.
      const releaseGuests = guardGuestPointers()
      // Open the resize gesture: it suppresses the :root geometry-var writes
      // (geometry.ts — each restyles the whole document) and throttles every
      // ResizeObserver reaction downstream of the width change, both of which
      // otherwise run every frame of the drag. Released in `cleanup`.
      beginResizeGesture()

      // Exactly what React last rendered onto the two wrappers, captured BEFORE
      // the first preview write. Only needed for the zero-movement click: no
      // store write means no re-render, so nothing would otherwise overwrite
      // the preview and the seam would stay where the pointer grazed it.
      const styleA = kidA.getAttribute('style')
      const styleB = kidB.getAttribute('style')

      // The two sides' share of the run's grow pool, read from what React last
      // rendered. A flex-vs-flex preview MOVES grow between them rather than
      // replacing it (see previewSide), so this total is the invariant the
      // whole drag preserves.
      const growOf = (el: HTMLElement) => Number.parseFloat(window.getComputedStyle(el).flexGrow) || 0
      const growTotal = growOf(kidA) + growOf(kidB)

      /**
       * Move one side of the seam by writing inline style — no store, no
       * re-render. The asymmetry between the branches is the subtle part:
       *
       *  - a FIXED side renders `flex: 0 1 <track>`, so `flexBasis` alone
       *    carries the whole delta and grow/shrink stay React's. Its flex
       *    partner is deliberately left untouched, so it keeps absorbing the
       *    remainder exactly as the track model would have rendered it —
       *    writing both sides here produced a phantom gap where a hidden
       *    sidebar lived.
       *  - a FLEX-vs-FLEX seam SPLITS the pair's grow by the new px ratio.
       *    This used to pin both sides to `0 1 <px>`, on the reasoning that
       *    their combined px is constant so the rest of the run sees an
       *    unchanged leftover. True of the leftover, false of who claims it:
       *    `grow(i)` (below) normalizes the run's grows to sum to 1, so
       *    zeroing two of them left the survivors claiming a FRACTION of the
       *    free space and the remainder claimed by nobody — a blank band at
       *    the end of the flex line for the length of the drag. Invisible
       *    with exactly two flex tracks (the pair IS the run); any third one
       *    leaks. Redistributing keeps the sum at `growTotal`, so the run
       *    still claims 100% and the preview matches what the commit renders.
       */
      const previewSide = (el: HTMLElement, fixed: boolean, px: number) => {
        if (fixed) {
          el.style.flexBasis = `${px}px`
        } else if (!a.fixed && !b.fixed) {
          const g = previewGrow(growTotal, px, a0px + b0px)

          el.style.flex = `${g} ${g} 0px`
        }
      }

      const previewShift = (shiftPx: number) => {
        previewSide(kidA, a.fixed, a0px + shiftPx)
        previewSide(kidB, b.fixed, b0px - shiftPx)
      }

      // The COMMIT, run once on release. Writing this per frame is what made a
      // drag re-render the whole pane tree 60 times a second — the store write
      // is cheap, but everything downstream of it is not.
      const applyShift = (shiftPx: number) => {
        if (a.fixed) {
          a.paneIds.forEach(id => setOverride(id, Math.round(a0px + shiftPx)))
        }

        if (b.fixed) {
          b.paneIds.forEach(id => setOverride(id, Math.round(b0px - shiftPx)))
        }

        if (!a.fixed && !b.fixed) {
          const weights = [...node.weights]
          // Clamped px → weights so persisted weights match what's on screen.
          weights[aIndex] = (a0px + shiftPx) / pxPerWeight
          weights[bIndex] = (b0px - shiftPx) / pxPerWeight
          setTreeSplitWeights(node.id, weights)
        }
      }

      // pointermove outpaces 60fps, so coalesce to one PREVIEW per frame.
      const resize = rafCoalesce(previewShift)
      let lastShift: null | number = null
      let done = false

      const onMove = (ev: PointerEvent) => {
        // `clientX` grows rightward in every locale; the seam's two sides have
        // swapped under `dir=rtl`, so an unsigned delta would grow the zone the
        // drag is shrinking. `lo`/`hi` are already in the seam's own frame.
        const delta = horizontal ? (ev.clientX - start) * directionSign(handle) : ev.clientY - start
        lastShift = Math.max(lo, Math.min(hi, delta))
        resize.push(lastShift)
      }

      // Ends through several racing paths (pointerup, pointercancel, window
      // blur, lostpointercapture — `releasePointerCapture` below fires the
      // latter re-entrantly), so it must run exactly once: a second pass would
      // re-commit `lastShift` against already-committed sizes and re-publish
      // the geometry vars the first pass just settled.
      const cleanup = () => {
        if (done) {
          return
        }

        done = true
        resize.finish()

        if (lastShift !== null) {
          // One store commit for the whole gesture. The re-render it triggers
          // rewrites each wrapper's `flex` SHORTHAND, and setting a shorthand
          // resets its longhands — so the `flexBasis` the preview wrote is
          // cleared by the very commit that installs the real value. No flash,
          // and no manual teardown to forget.
          applyShift(lastShift)
        } else {
          // A click with no movement: nothing will re-render, so put the
          // wrappers back exactly as React last wrote them.
          if (styleA === null) {
            kidA.removeAttribute('style')
          } else {
            kidA.setAttribute('style', styleA)
          }

          if (styleB === null) {
            kidB.removeAttribute('style')
          } else {
            kidB.setAttribute('style', styleB)
          }
        }

        // AFTER the final store write above — re-enabling first would publish
        // the pre-commit geometry and then take a second RO-driven publish
        // immediately after. Ordering is load-bearing, and it is also what makes
        // the throttle's end-of-gesture flush see the committed sizes.
        endResizeGesture()
        releaseGuests()
        document.body.style.cursor = restoreCursor
        document.body.style.userSelect = restoreSelect

        try {
          handle.releasePointerCapture?.(pointerId)
        } catch {
          // Mirror.
        }

        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', cleanup, true)
        window.removeEventListener('pointercancel', cleanup, true)
        window.removeEventListener('blur', cleanup)
        handle.removeEventListener('lostpointercapture', cleanup)
        persistTree()
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', cleanup, true)
      window.addEventListener('pointercancel', cleanup, true)
      // The gesture can also end without a pointerup: the window loses focus
      // mid-drag, or capture is taken away. Without these the seam stayed glued
      // to the cursor with `col-resize` and `user-select: none` still pinned on
      // the body, and the resize gesture never closed — every ResizeObserver
      // downstream stayed throttled for the rest of the session.
      window.addEventListener('blur', cleanup)
      handle.addEventListener('lostpointercapture', cleanup)
    },
    // trackCtx is derived state rebuilt per render; the drag captures it once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axis, editMode, horizontal, node.children, node.id, node.weights, hiddenPanes, narrow, overrides, byId]
  )

  // Double-click a sash: every neighbor returns to its DEFAULT size.
  //  - fixed zones (sidebar stacks): clear the drag override -> the declared
  //    width (237px etc.) comes back;
  //  - flex zones fronted by a size-declaring pane (a sidebar in a mixed
  //    stack): pin the weight so the zone lands EXACTLY on that size;
  //  - everything else: the preset's weights for this split (rearranging
  //    panes keeps the applied preset's split ids), else even distribution.
  const resetBoundary = useCallback(
    (aIndex: number, bIndex: number) => {
      const container = containerRef.current

      if (!container) {
        return
      }

      const setOverride = horizontal ? setPaneWidthOverride : setPaneHeightOverride

      for (const [child, edge] of [
        [node.children[aIndex], 'end'],
        [node.children[bIndex], 'start']
      ] as const) {
        const zone = edgeFixedZone(child, edge, axis, trackCtx)

        for (const paneId of zone ? shownPaneIds(zone, trackCtx) : []) {
          setOverride(paneId, undefined)
        }
      }

      const preset = presetSplitWeights(node.id, node.weights.length)
      const weights = preset ?? [...node.weights]

      const rect = container.getBoundingClientRect()
      const totalPx = horizontal ? rect.width : rect.height
      let pinned = false

      for (const i of [aIndex, bIndex]) {
        const child = node.children[i]

        // Fixed tracks size themselves from the declared width (override
        // cleared above) — weights only matter for FLEX zones.
        if (child.type !== 'group' || fixedTrackSize(child, axis, trackCtx) !== null) {
          continue
        }

        // The zone's natural default = the largest size any of its panes
        // declares along this axis (a sessions+terminal stack is still a
        // 237px sidebar at heart, whichever chip is fronted).
        let px: number | null = null

        for (const paneId of shownPaneIds(child, trackCtx)) {
          // No override: the sash cleared it above, and we want the zone's
          // NATURAL default to drag from.
          const css = tileAxisLength(paneFor(paneId), axis)
          const resolved = css ? resolveCssPx(container, css, horizontal) : null

          if (resolved !== null) {
            px = Math.max(px ?? 0, resolved)
          }
        }

        if (px === null || px <= 0 || px >= totalPx) {
          continue
        }

        const others = weights.reduce((sum, w, j) => (j === i ? sum : sum + w), 0)

        if (others > 0) {
          weights[i] = (px * others) / (totalPx - px)
          pinned = true
        }
      }

      setTreeSplitWeights(node.id, !preset && !pinned ? weights.map(() => 1) : weights)
    },
    // Same substitution as `startSash` above: `trackCtx` and `paneFor` are
    // rebuilt every render, so this array lists their INPUTS instead —
    // `trackCtx` is `{ paneFor, paneGone, overrides }`, `paneFor` reads `byId`,
    // and `paneGone` adds `editMode`/`hiddenPanes`/`narrow`. All five are here,
    // so the callback's behaviour is fully covered without churning identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axis, editMode, horizontal, node.children, node.id, node.weights, hiddenPanes, narrow, overrides, byId]
  )

  // One pass per child: enclosure, resolved fixed track and clamps.
  // fixedTrackSize + subtreeGone each re-walk the subtree, so resolve them ONCE
  // here instead of per read below.
  const tracks = node.children.map(child => {
    const { collapsed, minimized, narrowCollapsed } = zoneEnclosure(child, enclosureCtx, horizontal)
    const track = minimized || collapsed ? null : fixedTrackSize(child, axis, trackCtx)
    const sizing = minimized || collapsed ? null : sizingFor(child)

    return { child, collapsed, minimized, narrowCollapsed, sizing, track }
  })

  const growable = tracks.map((_, i) => i).filter(i => !tracks[i].collapsed && !tracks[i].minimized)
  const allFixed = growable.length > 0 && growable.every(i => tracks[i].track !== null)
  const absorberIndex = allFixed ? growable[growable.length - 1] : -1

  // Weights are RATIOS, but CSS flex-grow is absolute: a run whose grows sum
  // below 1 fills only that fraction of the leftover (normalize's flatten
  // scales weights into the parent slot — a dock-split nested into an
  // existing column can leave grow 0.5, i.e. dead space). Renormalize the
  // flex run so its grows always sum to 1.
  const flexTotal = growable.reduce((sum, i) => sum + (tracks[i].track === null ? node.weights[i] : 0), 0)
  const grow = (i: number) => node.weights[i] / (flexTotal || 1)

  // The seam partner for a visible child: the nearest VISIBLE previous
  // sibling. Collapsed zones (a hidden pane parked mid-row) are skipped, so
  // their visible neighbors keep a shared, draggable boundary.
  const seamPartner = (i: number): number => {
    for (let j = i - 1; j >= 0; j--) {
      if (!tracks[j].collapsed) {
        return j
      }
    }

    return -1
  }

  // Which half of this row a visible child sits in — a minimized zone's rail
  // hugs the app edge it collapsed toward, so its divider stroke must face
  // the content side (left rail → stroke right, right rail → stroke left).
  const visibleOrder = tracks.map((t, j) => (t.collapsed ? -1 : j)).filter(j => j >= 0)

  const railSideFor = (i: number): 'left' | 'right' => {
    const pos = visibleOrder.indexOf(i)

    return pos >= 0 && (pos + 0.5) / visibleOrder.length > 0.5 ? 'right' : 'left'
  }

  // The tracks pass above is the layout calculation, and on a clock clamped to
  // 1ms it times as zero however much tree it walked. So report the SHAPE of
  // the work instead and let the counter module total it per frame — see
  // observability/auto/layout-counters.ts. Null in release.
  notifySplitRender(node.id, node.children.length, subtreePanes.length)

  return (
    <div
      className={cn('flex min-h-0 min-w-0 flex-1', horizontal ? 'flex-row' : 'flex-col')}
      data-tree-split={node.id}
      ref={containerRef}
    >
      {tracks.map(({ child, collapsed, minimized, narrowCollapsed, sizing, track }, i) => {
        const partner = collapsed ? -1 : seamPartner(i)

        return (
          <div
            className="relative flex min-h-0 min-w-0"
            key={child.id}
            style={
              collapsed
                ? { display: 'none' }
                : minimized
                  ? { flex: '0 0 auto' }
                  : {
                      // One flexbox formula for everything: a sized zone is
                      // grow-0 shrink-1 from its preferred basis (it yields
                      // gracefully on tight windows, floored by min-width);
                      // everything else splits the leftover by weight. In an
                      // all-fixed run the last track grows into the leftover.
                      flex: track ? `${i === absorberIndex ? 1 : 0} 1 ${track}` : `${grow(i)} ${grow(i)} 0px`,
                      // Pane-declared clamps apply along THIS split's axis only
                      // (a rail's width clamp shouldn't constrain its height).
                      // The absorber drops its max clamp — it exists to fill
                      // the leftover, and clamping would recreate the gap.
                      minWidth: (horizontal && sizing?.minWidth) || 0,
                      maxWidth: horizontal && i !== absorberIndex ? sizing?.maxWidth : undefined,
                      minHeight: (!horizontal && sizing?.minHeight) || 0,
                      maxHeight: horizontal || i === absorberIndex ? undefined : sizing?.maxHeight
                    }
            }
          >
            {partner >= 0 && (
              <Sash
                disabled={minimized || tracks[partner].minimized}
                horizontal={horizontal}
                onDoubleClick={() => resetBoundary(partner, i)}
                onPointerDown={e => startSash(partner, i, e)}
              />
            )}
            {!narrowCollapsed && (
              <TreeNode
                // WHERE THE FOLD IS BORN: a child SPLIT that reads as minimized
                // is one whose every visible zone is minimized (subtreeFolded),
                // so it renders as a single strip along THIS split's axis — and
                // everything under it must take its strip form from that axis,
                // not from its own orientation. Already-folded subtrees pass the
                // outer context straight through: the fold has exactly one
                // origin, the outermost split that collapsed.
                folded={
                  folded ??
                  (child.type === 'split' && minimized
                    ? { axis, railSide: horizontal ? railSideFor(i) : undefined }
                    : undefined)
                }
                node={child}
                parentAxis={axis}
                railSide={horizontal ? railSideFor(i) : undefined}
                rootRow={rootRow || childRootRow(child)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function Sash({
  disabled,
  horizontal,
  onDoubleClick,
  onPointerDown
}: {
  disabled?: boolean
  horizontal: boolean
  onDoubleClick?: () => void
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={cn(
        'group absolute z-20 [-webkit-app-region:no-drag]',
        // A flex row already mirrors under `dir=rtl`, so the sash follows with a
        // logical inset. Its half-width straddle is a transform, which does not
        // mirror — hence the sign. (The hairline and hover strip below stay
        // `left-1/2 -translate-x-1/2`: that pair is centring, not an edge.)
        horizontal
          ? 'inset-y-0 start-0 w-[9px] translate-x-[calc(-50%*var(--dir-flip-x))]'
          : 'inset-x-0 top-0 h-[9px] -translate-y-1/2',
        disabled ? 'pointer-events-none' : horizontal ? 'cursor-col-resize' : 'cursor-row-resize'
      )}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      onPointerDown={disabled ? undefined : onPointerDown}
      role="separator"
    >
      {/* Persistent hairline: same token as PaneShell's divider sash
          (--ui-stroke-secondary) so every seam — vertical or horizontal —
          reads identically. */}
      <span
        className={cn(
          'absolute bg-(--ui-stroke-secondary)',
          // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- centring, not an edge — pairs with a physical -translate-x-1/2, and start-1/2 would resolve to right:50% while the transform still pulled left
          horizontal ? 'inset-y-0 left-1/2 w-px -translate-x-1/2' : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
        )}
      />
      {!disabled && (
        <span
          className={cn(
            'absolute bg-(--ui-sash-hover-border) opacity-0 transition-opacity duration-100 group-hover:opacity-100',
            horizontal
              ? // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- centring, not an edge — pairs with a physical -translate-x-1/2, and start-1/2 would resolve to right:50% while the transform still pulled left
                'inset-y-0 left-1/2 w-(--vscode-sash-hover-size,0.25rem) -translate-x-1/2'
              : 'inset-x-0 top-1/2 h-(--vscode-sash-hover-size,0.25rem) -translate-y-1/2'
          )}
        />
      )}
    </div>
  )
}
