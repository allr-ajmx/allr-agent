/**
 * THE TILE — the leaf the layout tree stores.
 *
 * The tree's GEOMETRY (`tree/model.ts`) was always right: splits, stacked
 * zones, a lone tile hiding its strip. Its LEAF was not. A leaf was a bare
 * `string` id resolved at render time against the contribution registry, whose
 * payload is `data?: unknown` (`contrib/types.ts:42`) — and that ONE blob was
 * read through two uncoordinated casts in the same file (`(c?.data ?? {}) as
 * PaneChrome` and `(…?.data ?? {}) as PaneSizing`), plus ad-hoc ones in the
 * store, while the registration sites passed keys (`dock`, `revealOnPreset`)
 * that neither interface declared. Adding a field type-checked nothing.
 *
 * A Tile makes chrome, sizing and placement DECLARED SIBLINGS of one type
 * instead of two blind readings of one blob. It rides the same `Contribution`
 * transport (`tile/registry.ts`), so ordering, provenance, plugin loading and
 * area-scoped invalidation are untouched.
 */

import type { ReactElement, ReactNode, PointerEvent as ReactPointerEvent } from 'react'

import type { ContributionSource } from '@/contrib/types'

import type { PanePlacementHint } from '../tree/grid-to-tree'
import type { DropPosition } from '../tree/model'
import type { DoubleTapContext } from '../tree/renderer/drag-session'
import type { FloatingAnchor } from '../tree/renderer/floating-rect'

/** A tile's id. Also its pane id in the tree and its contribution id. */
export type TileId = string

/**
 * Where a tile wants to live.
 *
 * `'floating'` (MJXHRM-172) is the one NON-TILING placement: the tile opts out
 * of the tree entirely and renders as a fixed card above it — see
 * `tree/renderer/floating-panes.tsx`. `'detached'` (MJXHRM-173) is hosted by
 * another window; the tree keeps its slot so reattach is well-defined.
 *
 * Reserving both in the union from the start is what let each land as a
 * placement rather than as a second leaf type.
 */
export type TilePlacement = PanePlacementHint | 'detached' | 'floating'

/** Placements the grid→tree authoring pass understands. `'floating'` and
 *  `'detached'` have no grid slot, so they resolve to "unplaced". */
export const gridPlacement = (placement: TilePlacement | undefined): PanePlacementHint | undefined =>
  placement === 'floating' || placement === 'detached' ? undefined : placement

/** Where a RE-ADOPTED tile lands (healed from a stale dismissal, or a plugin
 *  tile joining the tree the moment it registers).
 *
 *  Named `…Hint`, not `TileDock`: `store/session-states` already exports a
 *  `TileDock`, and that one is a DIRECTION (`'center' | SplitDir`). Two types a
 *  session tile touches, one called dock and one called dock, would be a trap. */
export interface TileDockHint {
  pane: TileId
  pos: DropPosition
  /** Center docks: stack BEFORE this tile id (the strip divider's slot). */
  before?: null | string
}

/**
 * Optional CSS sizing a tile contributes. Applied to the tile's GROUP along the
 * axis of the split that contains it — same semantics as the app's
 * `Pane width/minWidth/maxWidth` props: a `width`/`height` makes the zone a
 * FIXED track (sidebar-style: it keeps its size and the weighted zones absorb
 * the rest); without one the zone shares leftover space by weight.
 */
export interface TileSizing {
  width?: string
  height?: string
  minWidth?: string
  maxWidth?: string
  minHeight?: string
  maxHeight?: string
}

/** Chrome behaviour a tile contributes — everything about how its TAB and its
 *  zone's header behave, as opposed to how the zone is sized. */
export interface TileChrome {
  /** Leaves the grid on narrow viewports; revealed as an edge overlay. */
  collapsible?: boolean
  /** No Close in the tab menu — the one surface the app can't lose (the main
   *  workspace). Session tiles share `placement: 'main'` but close. */
  uncloseable?: boolean
  /** Suppress the zone header while THIS tile is active — full-page views
   *  (artifacts/skills/plugin pages) are not tab-able surfaces. Live: the
   *  workspace tile re-registers it on route changes. */
  headerVeto?: boolean
  /** A layout preset that PLACES this tile turns it on, so the zone shows
   *  instead of staying collapsed behind its toggle (⌃` for the terminal). */
  revealOnPreset?: boolean
  /** Extra ids accepted from PANE_TOGGLE_REVEAL_EVENT (the legacy app's pane
   *  ids, e.g. `chat-sidebar` for `sessions`). */
  revealAliases?: string[]
  /** A lead-dot color for this tile's TAB (a session tab inheriting its project
   *  color). Generic — any tile may contribute one; the strip just renders a
   *  tinted dot before the label. Live: re-registered when the color changes. */
  accent?: string
  /** Where a re-adopted tile docks. */
  dock?: TileDockHint
  /** Spawn corner for `placement: 'floating'` (default `'top-right'`). A
   *  right/bottom anchor also makes the card TRACK that edge on resize, so it
   *  stays in its corner instead of being dragged inward only when it would
   *  fall off. Ignored for every tiling placement. */
  anchor?: FloatingAnchor
  /** Wrap this tile's TAB (e.g. in a domain context menu — a session tile's
   *  pin/branch/rename/archive/delete). The wrapper must render `tab` as its
   *  interactive child; the zone's own strip menu still owns non-tab space. */
  tabWrap?: (tab: ReactElement) => ReactNode
  /** Override this tile's TAB drag (a session tab drags like a sidebar row —
   *  stack / split / composer-link — not the generic pane move). Given the
   *  tab's tap (activate) + double-tap (hide header) so those gestures survive.
   *  Returns whether it took the drag; `false` (or absent) defers to
   *  `startPaneDrag` — e.g. the workspace tab on a fresh draft, nothing to link. */
  tabDrag?: (event: ReactPointerEvent<HTMLElement>, onTap: () => void, double?: DoubleTapContext) => boolean
  /** Force this tile's zone to keep its tab strip even when it is the only tile
   *  in it. Default is contextual — a lone tile isn't a "tab", so its header
   *  auto-hides — but a tile that can be CLOSED needs somewhere to put the ✕. */
  loneHeader?: boolean
  /**
   * This tile's zone accepts a LINK drop — dragging a session onto the middle
   * of the zone links it into this surface rather than stacking it as a tab.
   *
   * Declared rather than inferred: the zone renderer used to decide this with
   * `node.panes.some(isChatPaneId)`, i.e. by reading a chat id prefix. What
   * makes a zone linkable is what its tenants can accept, which is theirs to
   * say.
   */
  linkTarget?: boolean
  /**
   * A TOOL PANEL (terminal, logs) — the IntelliJ/VS-Code tool-window model.
   * Its toggle COLLAPSES the zone to a persistent rail (the tab stays) rather
   * than hiding it, and its ✕ REMOVES it from the layout (it comes back via the
   * toggle) rather than routing through a Close that ends something, the way a
   * session tile's ✕ ends the session.
   *
   * This was a module-level `Set` in the tree store, written once at controller
   * import and read during render. It is a TRAIT of the surface, not state: a
   * terminal is a tool panel in every layout, forever. Declaring it here is what
   * makes that structural instead of accidental.
   */
  toolPanel?: boolean
}

/**
 * What happens to a tile's content when its tab is switched away from.
 *
 * `keep-alive` (the default) leaves it mounted and hidden, so a chat keeps its
 * scroll position across a tab round-trip. `unmount` is the opt-out for a
 * surface heavy enough that holding it costs more than rebuilding it — nothing
 * declares it today. Honoured by the zone renderer's kept-set (MJXHRM-170).
 */
export type TileLifecycle = 'keep-alive' | 'unmount'

export interface Tile {
  id: TileId
  /**
   * What KIND of surface this is — `'chat'`, `'terminal'`, `'files'`,
   * `'plugin:<id>'`. The engine must never branch on it (that is what
   * `isChatPaneId` did, and why stacking two terminals renders a strip the
   * keyboard can't switch); it exists for telemetry, for tile-kind-scoped
   * verbs a tile opts into, and so a human reading a persisted tree can tell
   * what a leaf was.
   */
  kind: string
  /** Tab label. Live-retitleable — re-registering the same id replaces it. */
  title: string
  render: () => ReactNode

  placement?: TilePlacement
  chrome?: TileChrome
  sizing?: TileSizing
  lifecycle?: TileLifecycle
  /** The strip's `+`, contributed BY the tile rather than by a module-global
   *  handler. Declared here, wired in MJXHRM-168. */
  onNewTab?: () => void

  /** Provenance, straight through to the contribution. */
  source?: ContributionSource
  /** Ascending sort key within the pane area; ties keep insertion order. */
  order?: number
}

/** A tile's chrome, never undefined — the read every renderer wants. */
export const tileChrome = (tile: Tile | undefined): TileChrome => tile?.chrome ?? {}

/** A tile's sizing, never undefined. */
export const tileSizing = (tile: Tile | undefined): TileSizing => tile?.sizing ?? {}
