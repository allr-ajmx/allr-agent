/**
 * Group node renderer — a ZONE: header strip (tabs when stacked, minimize
 * chevron) + the active pane's content, resolved from the contribution
 * registry (`area: 'panes'`). Empty zones exist only in editor-authored
 * trees (drop targets until the first structural op prunes them).
 *
 * Dragging is FancyZones-style (drag-session.ts): the layout stays fixed and
 * every zone lights up as a whole-region drop target. Right-click opens the
 * contextual zone menu (split/move + header/minimize toggles).
 */

import { useStore } from '@nanostores/react'
import {
  type CSSProperties,
  Fragment,
  Profiler,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { CONTEXT_KIT } from '@/components/ui/actions-menu'
import { Codicon } from '@/components/ui/codicon'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DecodeText } from '@/components/ui/decode-text'
import { DROP_SHEET_BLUR_CLASS, DROP_SHEET_CLASS } from '@/components/ui/drop-affordance'
import {
  PANE_TAB_STRIP_LINE_LEFT,
  PANE_TAB_STRIP_LINE_RIGHT,
  PaneStripGlyph,
  PaneTab,
  paneTabCloseItems,
  PaneTabLabel,
  PaneTabStrip
} from '@/components/ui/pane-tab'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { ContribBoundary } from '@/contrib/react/boundary'
import { useI18n } from '@/i18n'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { DEV_TOOLS_ENABLED } from '@/observability/enabled'
import { canOpenNewWindow } from '@/store/windows'

import { $layoutEditMode } from '../../edit-mode'
import { hiddenPaneProps, PaneGroupContext, PaneVisibleContext } from '../../pane-visibility'
import { $detachedTiles, detachTile, reattachTile } from '../../tile/detach'
import { useTileMap } from '../../tile/registry'
import { tileChrome } from '../../tile/types'
import { type TileContext, tileShown, tileVisibility } from '../../tile/visibility'
import type { DropPosition, GroupNode, RootEdge } from '../model'
import { adjacentGroup } from '../model'
import {
  $dropHint,
  $hiddenTreePanes,
  $layoutTree,
  $narrowViewport,
  $panesWithCloser,
  $stripToolsRevision,
  $treeDragging,
  $treePaneEpochs,
  activateTreePane,
  closeAllTreeTabs,
  closeOtherTreeTabs,
  closeTabPane,
  closeTreeTabsToRight,
  collapseTreePane,
  isCollapsePane,
  moveTreePane,
  reloadTreePane,
  restoreTreePane,
  SESSION_TILE_DRAG,
  setTreeGroupHeaderHidden,
  splitTreeZone,
  toggleTreeGroupMinimized,
  treeTabCloseTargets
} from '../store'
import {
  $tabSelection,
  clearTabSelection,
  isToggleSelectClick,
  selectionFor,
  selectTabRange,
  toggleTabSelected
} from '../tab-selection'

import { type DoubleTapContext, startPaneDrag } from './drag-session'
import { forceLoneHeaderForPanes } from './lone-header'
import { useActiveTabVisible } from './tab-strip-scroll'
import { notifyPaneCommit, notifyZoneRender } from './telemetry'

/**
 * Times a pane's CONTENT, separately from the layout tree around it.
 *
 * The root Profiler could say "the layout tree committed for 20ms" and the
 * zone/split counters could say the tree itself did not re-render — which
 * together locate the work below `TreeGroup`, in a pane's content, and go no
 * further. A resize that costs a second of React is not actionable until you
 * know whether that second is the file tree, the transcript or the terminal.
 *
 * Only the panes that actually committed fire, so the span volume tracks the
 * work rather than the pane count. Nested inside the root Profiler on purpose:
 * its `actualDuration` is ALSO counted in the root's, so the two must never be
 * summed — the root is the total and this is the breakdown.
 *
 * Dev/bench only: `<Profiler>` adds per-commit timing to its whole subtree.
 */
function PaneProfiler({ children, kind }: { children: ReactNode; kind: string }) {
  if (!DEV_TOOLS_ENABLED) {
    return children
  }

  return (
    <Profiler id={kind} onRender={notifyPaneCommit}>
      {children}
    </Profiler>
  )
}

/**
 * What a zone shows while its tile is detached to another window.
 *
 * Deliberately inert-looking: the slot is being HELD, not used. Reattach is the
 * only affordance, because closing the host window does the same thing — there
 * is exactly one way back and this is a shortcut to it, not a second mode.
 */
function DetachedSlot({ paneId, title }: { paneId: string; title: string }) {
  const { t } = useI18n()

  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <Codicon className="text-(--ui-text-quaternary)" name="multiple-windows" size="1rem" />
        <p className="text-xs text-(--ui-text-tertiary)">{t.zones.detachedBody(title)}</p>
        <button
          className="rounded-md border border-(--ui-stroke-tertiary) px-2 py-1 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground"
          onClick={() => void reattachTile(paneId)}
          type="button"
        >
          {t.zones.reattach}
        </button>
      </div>
    </div>
  )
}

/** A directional action in the zone menu (computed per group state). */
interface ZoneMenuDirection {
  side: RootEdge
  label: string
  run: () => void
}

const DIRECTION_ORDER: readonly RootEdge[] = ['right', 'bottom', 'left', 'top']
const DIRECTION_ARROW: Record<RootEdge, string> = { bottom: '↓', left: '←', right: '→', top: '↑' }

/** Right-click zone menu: directional actions + header toggle + minimize.
 *  The directions are CONTEXTUAL (computed by TreeGroup): a stacked group
 *  offers "Split <dir>" (carve a new zone with the clicked pane — VS Code
 *  split-and-move in one gesture); a single-pane group offers "Move <dir>"
 *  into the zone actually sitting on that side — directions with no visible
 *  neighbor aren't offered, so no action ever appears to do nothing. */
function ZoneMenu({
  children,
  closable,
  detachable,
  minimizable = true,
  directions,
  headerHidden,
  menuTarget,
  minimized,
  nodeId
}: {
  children: ReactNode
  /** The pane the menu closes (the right-clicked chip / the active pane);
   *  undefined = not closable (the main zone). */
  closable?: () => string | undefined
  /** The pane the menu ACTS ON, closeable or not. The plain Close is gated on
   *  `closable`, but "close others / to the right / all" are relative to this
   *  tab and mean something even on the uncloseable workspace. */
  menuTarget: () => string
  /** The pane the menu detaches to its own window; undefined when this platform
   *  has no second window, or the pane is already detached. */
  detachable?: () => string | undefined
  /** False for the zone hosting the uncloseable workspace — collapsing the
   *  MAIN pane strands the app behind a strip. */
  minimizable?: boolean
  /** Called when the MENU renders, not on every zone re-render: resolving the
   *  neighbour zones has to read the layout tree, and subscribing every zone to
   *  it made a tree write re-render every mounted pane. Same lazy shape as
   *  `closable`. */
  directions: () => ZoneMenuDirection[]
  headerHidden?: boolean
  minimized?: boolean
  nodeId: string
}) {
  const { t } = useI18n()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {/* Reload what is IN the tab — browser parity, and the only recovery
            for a surface that wedged without taking the whole app with it. */}
        <ContextMenuItem onSelect={() => reloadTreePane(menuTarget())}>{t.zones.reload}</ContextMenuItem>
        {directions().map(direction => (
          <ContextMenuItem key={direction.side} onSelect={direction.run}>
            {direction.label}
          </ContextMenuItem>
        ))}
        {/* The named form of the tear-off (drag a tab clear of the window):
            same verb, same `canDetach` rule, for when the gesture isn't handy
            or the pane is a keyboard-only reach. Resolved at render like
            `closable`, so the item names the pane actually right-clicked. */}
        {detachable?.() !== undefined && (
          <ContextMenuItem
            onSelect={() => {
              const paneId = detachable?.()

              if (paneId) {
                void detachTile(paneId)
              }
            }}
          >
            {t.zones.detach}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => setTreeGroupHeaderHidden(nodeId, !headerHidden)}>
          {headerHidden ? t.zones.showHeader : t.zones.hideHeader}
        </ContextMenuItem>
        {minimizable && (
          <ContextMenuItem onSelect={() => toggleTreeGroupMinimized(nodeId, !minimized)}>
            {minimized ? t.zones.restore : t.zones.minimize}
          </ContextMenuItem>
        )}
        {/* The shared tab close group — Close / others / to the right / all —
            so every tab in the app (session, page, preview, tool panel) answers
            a right-click identically. Resolved at render: the menu mounts on
            open, after the right-click set menuPane, so an uncloseable target
            drops Close instead of offering a dead action while keeping the
            verbs that still mean something for its zone. */}
        {paneTabCloseItems(CONTEXT_KIT, {
          counts: treeTabCloseTargets(menuTarget()),
          // `closeTabPane`, NOT `closeTreePane`: the tab close verb has to
          // dismiss a TOOL PANEL from the tree before running its closer, or
          // Close on the terminal only collapses the zone to a rail and reads
          // as a no-op (see closeToolPane). Commit f3bf0b27fe fixed that for
          // ⌘W / ⌘-click / middle-click and left this one call behind.
          onClose: closable?.() === undefined ? undefined : () => closeTabPane(closable()!),
          onCloseAll: () => closeAllTreeTabs(menuTarget()),
          onCloseOthers: () => closeOtherTreeTabs(menuTarget()),
          onCloseToRight: () => closeTreeTabsToRight(menuTarget())
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function TreeGroup({
  foldAxis,
  node,
  parentAxis,
  railSide = 'left'
}: {
  /** Set when an ancestor split is CASCADE-FOLDED (see FoldContext): the zone
   *  collapses along the fold's axis instead of its own parent's. */
  foldAxis?: 'column' | 'row'
  node: GroupNode
  parentAxis?: 'column' | 'row'
  railSide?: 'left' | 'right'
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  // The SCROLLER inside the header, not the header itself: `stripRef` is what
  // the drop caret and the drag session measure against, and it doesn't scroll.
  const tabsRef = useRef<HTMLDivElement>(null)
  // The chip under the last right-click — the pane the zone menu's Split
  // actions carry into the new zone (header background = the active pane).
  // STATE, not a ref: the menu items (incl. Close's visibility) are JSX
  // evaluated during THIS component's render — a ref write on right-click
  // doesn't re-render, so the menu showed the PREVIOUS target's items (Close
  // missing on an inactive tile tab whose zone-active was the uncloseable
  // workspace).
  const [menuPane, setMenuPane] = useState<string | undefined>(undefined)
  const byId = useTileMap()
  // Coarse drag flag only (set once at drag start/end). The per-frame drop
  // HINT lives in ZoneDropOverlay so a moving pointer re-renders the tiny
  // overlay, not every zone's header/body (and not the menuDirections walk).
  const dragging = useStore($treeDragging)
  const editMode = useStore($layoutEditMode)

  const hiddenPanes = useStore($hiddenTreePanes)
  const narrow = useStore($narrowViewport)

  // NARROWED (MJXHRM-381). These four atoms are global but every read below is
  // about THIS zone's panes, so subscribing to the whole value meant one zone's
  // detach, close-registration, Reload or tab-selection re-rendered every zone
  // in the tree — headers, tab strips and the `menuDirections` walk included.
  //
  // `useStoreSelector` bails on `Object.is` of the SELECTED value, so each
  // selector has to collapse to a scalar. For the three set/record reads that
  // means a signature string over this node's pane list, rebuilt into a Set only
  // when the signature actually moves. `node.panes` is in the dep arrays because
  // a zone that gains a pane must re-derive its own membership.
  const detachedKey = useStoreSelector($detachedTiles, panes => node.panes.filter(id => panes.has(id)).join('\u0000'))
  const detached = useMemo(() => new Set(detachedKey ? detachedKey.split('\u0000') : []), [detachedKey])

  const closerKey = useStoreSelector($panesWithCloser, panes => node.panes.filter(id => panes.has(id)).join('\u0000'))
  const panesWithCloser = useMemo(() => new Set(closerKey ? closerKey.split('\u0000') : []), [closerKey])

  // Reload epochs: only an explicit tab-menu Reload writes here, but that write
  // is a whole-record replace, so an unnarrowed read remounted nothing and
  // re-rendered everything.
  const epochKey = useStoreSelector($treePaneEpochs, epochs => node.panes.map(id => epochs[id] ?? 0).join('\u0000'))

  // Decoded BY POSITION against the same `node.panes` the signature was built
  // from, which is therefore a real dependency and not a folded-in constant. The
  // signature carries epoch VALUES, not ids: a zone that swaps one pane for
  // another whose epoch happens to match keeps a byte-identical signature, so
  // keying the memo on the signature alone handed the incoming pane the outgoing
  // pane's entry — and for an empty zone `''.split()` yields `['']`, i.e. an
  // `{ undefined: 0 }` map. Both are recoverable (an epoch is only a remount key
  // and a missing entry falls back to 0), but neither is intended.
  const paneEpochs = useMemo(() => {
    const values = epochKey ? epochKey.split('\u0000') : []
    const epochs: Record<string, number> = {}

    node.panes.forEach((id, index) => {
      epochs[id] = Number(values[index]) || 0
    })

    return epochs
  }, [epochKey, node.panes])

  // Multi-tab selection (⌥/Ctrl-click, Shift-click) lives in ONE zone at a time.
  // Selecting to `null` for every other zone is what makes this quiet: the other
  // zones' snapshots compare equal and never re-render.
  const tabSelection = useStoreSelector($tabSelection, selection =>
    selection?.groupId === node.id ? selection : null
  )

  // A tile's strip tools are read during THIS render (see `stripTools` below),
  // so a glyph whose state moved without the tile re-registering needs a nudge.
  useStore($stripToolsRevision)

  const paneFor = (id: string) => byId.get(id)

  // Unregistered (plugin not loaded), chrome-toggled-off, and narrow-collapsed
  // tiles drop out of the header; the active tile falls back to the first shown
  // one (render-side — the tree keeps `active`). The rule itself lives in
  // tile/visibility.ts, shared with the split renderer.
  const tileCtx: TileContext = { editMode, hidden: hiddenPanes, narrow, tileFor: paneFor }

  const shown = node.panes.filter(id => tileShown(id, tileCtx))
  const activeId = shown.includes(node.active) ? node.active : (shown[0] ?? node.active)
  const active = paneFor(activeId)
  const isEmpty = node.panes.length === 0

  // KEEP-ALIVE. The zone used to render only the active tile, so every tab
  // switch unmounted a whole surface and mounted another — the thread lost its
  // scroll position and the layout shifted while it re-measured.
  //
  // Lazy on purpose: a tile first mounts when it is first ACTIVATED, so a
  // boot-restored stack of five sessions doesn't resume all five up front.
  const everActiveRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // `shown.includes` matters: with every tile in the zone toggled off,
    // `activeId` falls back to `node.active` — a tile that is NOT on screen.
    // Recording it there would make the zone's whole laziness contract depend
    // on which tab a persisted layout happened to leave active.
    if (!node.minimized && !isEmpty && shown.includes(activeId)) {
      everActiveRef.current.add(activeId)
    }

    // Prune tiles that left the zone (closed / moved to another group), so a
    // long-lived zone doesn't pin stale ids forever.
    for (const id of everActiveRef.current) {
      if (!node.panes.includes(id)) {
        everActiveRef.current.delete(id)
      }
    }
  })

  // A tile may opt OUT with `lifecycle: 'unmount'` — for a surface heavy enough
  // that holding it costs more than rebuilding it. Nothing declares that today;
  // the default is keep-alive because the surfaces that stack are chats, and a
  // chat is exactly what must not be rebuilt.
  const keepsAlive = (id: string) => paneFor(id)?.lifecycle !== 'unmount'

  // THE REVEAL AXIS KEEPS ITS BODY TOO (MJXHRM-373 follow-on).
  //
  // `keptPanes` filtered `shown`, and a tile its owning store toggled off is not
  // shown — so ⌘G, the titlebar side buttons and every `bindPaneVisibility`
  // binding tore their surface down and rebuilt it on the way back. That is the
  // same defect minimize had, on the other axis, and three places already
  // document the opposite contract: the REVEAL note in `tree/store.ts`, the
  // `hidden` outcome in `tile/visibility.ts` ("the zone collapses but the
  // content stays mounted, so toggling back is instant"), and the `idle()`
  // wrapper in `app/contrib/controller.tsx` (which exists to keep that mount off
  // the first-paint path — it had nothing to defer).
  //
  // Only `hidden`, and only once the tile has actually been on screen:
  //  - `enclosed` (narrow breakpoint) must stay unmounted — NarrowOverlays holds
  //    the ONE live instance, and a second copy here would double every effect
  //    the surface runs (for a terminal, a second shell).
  //  - a tile toggled off since boot has no state to preserve, so it stays lazy
  //    exactly like a never-activated tab.
  const hiddenKept = node.panes.filter(
    id =>
      !shown.includes(id) && tileVisibility(id, tileCtx) === 'hidden' && everActiveRef.current.has(id) && keepsAlive(id)
  )

  const keptPanes = [
    ...shown.filter(id => id === activeId || (everActiveRef.current.has(id) && keepsAlive(id))),
    ...hiddenKept
  ]

  // THE SIZE THE BODY FREEZES AT WHILE THE ZONE IS FOLDED (MJXHRM-373).
  //
  // A minimized zone shrinks to its header, so a body still in flow would be
  // squeezed to nothing — and a terminal squeezed to nothing refits to one row
  // and REFLOWS its scrollback, which is exactly what keeping it mounted is
  // supposed to protect. Pinning the last laid-out size and taking the body out
  // of flow means nothing inside it resizes at all: no refit, no PTY resize
  // over IPC, no scroller snapping to the top.
  //
  // Measured in a layout effect (before paint) on every render where the zone
  // is open, so the value is already right on the render that folds it. A ref,
  // not state: writing it must not schedule a render, and the render that reads
  // it is the one the tree's own store change already caused.
  //
  // It doubles as "this zone has been open at least once". A zone restored from
  // a persisted layout ALREADY folded has no size to freeze at — and nothing to
  // preserve either, since nothing ever mounted in it. Those stay lazy, which is
  // the same reason `everActiveRef` above exists: a boot-restored stack must not
  // resume five sessions (or spawn a shell) nobody has looked at.
  const bodyRef = useRef<HTMLDivElement>(null)
  const frozenBodyRef = useRef<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    const el = bodyRef.current

    if (node.minimized || !el) {
      return
    }

    const { height, width } = el.getBoundingClientRect()

    // Zero while the zone is mid-transition, or collapsed by its parent split;
    // freezing at zero is the reflow this whole mechanism exists to avoid.
    if (height > 0 && width > 0) {
      frozenBodyRef.current = { height, width }
    }
  })

  const frozenBody = frozenBodyRef.current
  const bodyMounted = !node.minimized || frozenBody !== undefined

  // ONE header style: the app's compact pane-header. DEFAULT is contextual —
  // a single pane isn't a "tab", so its header auto-hides; a stack shows its
  // chips. EXCEPTIONS force a lone pane to keep its header (tab + close X):
  //  - a TILE (closeable, placement 'main' — a session/page split), else a
  //    tile in its own zone is unclosable (the "3rd tile has no tab" trap);
  //  - a TOOL PANEL (terminal/logs — a collapse pane) dragged out of the main
  //    stack, else it's a dead zone with no tab to grab or ✕ to close.
  // The uncloseable workspace and side chrome (sessions/files) keep the clean
  // no-tab default. Double-click toggles it either way; a minimized group
  // always shows its header (it IS the header).
  // Session-tile ids force the header even before chrome registers — cycling
  // onto a freshly-split tile used to land headerless ("name card missing").
  const forceLoneHeader = forceLoneHeaderForPanes(shown, paneFor, isCollapsePane)

  // The `+` is contributed BY a tile (`Tile.onNewTab`), so any strip whose
  // tenants know how to make another one gets it. It used to be a module-global
  // singleton the session store registered, gated on the strip containing a
  // chat pane — which meant exactly one strip in the app could ever have a `+`,
  // and a plugin's stackable surface could not offer one at all.
  const onNewTab = shown.map(paneFor).find(tile => tile?.onNewTab)?.onNewTab

  // Glyphs the ACTIVE tile contributes to this strip (a preview's view-mode
  // switch), read fresh on every render so a tool's `active` flag tracks the
  // real thing rather than a snapshot taken at registration time.
  const stripTools = tileChrome(active).stripTools?.() ?? []

  // A full-page view (headerVeto) suppresses the strip while it's the active
  // pane — a page is not a tab-able surface; the bar returns with the chat.
  const headerHidden = tileChrome(active).headerVeto || (node.headerHidden ?? (shown.length <= 1 && !forceLoneHeader))

  // A group collapses ALONG its parent split's axis. In a row that means the
  // WIDTH collapses — a full-width horizontal header would strand a tall
  // empty column, so the minimized form is a narrow vertical rail instead
  // (tabs reading top-to-bottom). In a column (stacked zones) the horizontal
  // header IS the collapsed form, exactly as before. Inside a cascading fold
  // the FOLD's axis wins over the literal parent: a column that folded into a
  // row is a rail, so its zones are rails too, stacked down the rail.
  const verticalCollapse = Boolean(node.minimized) && (foldAxis ?? parentAxis) === 'row' && !isEmpty
  const headerVisible = !isEmpty && !verticalCollapse && (Boolean(node.minimized) || !headerHidden)

  // Opening a tab past the right edge otherwise left BOTH the new tab and the
  // `+` that made it off-screen. `last` scrolls to the very end rather than to
  // the tab's own edge, so the `+` (which lives after it in the same scroll
  // content) comes along. Off while the strip isn't rendered — the minimized
  // form is a rail with its own markup, and there is nothing to measure.
  useActiveTabVisible(tabsRef, activeId, {
    enabled: headerVisible && !node.minimized,
    tabCount: shown.length
  })

  // Drag handles preventDefault pointerdown (no native dblclick), so the
  // header + chips share a synthesized double-tap: restore if collapsed
  // (undoing the first tap's minimize toggle) and hide the chrome.
  const hideHeaderDoubleTap: DoubleTapContext = {
    key: `hide-header-${node.id}`,
    onDoubleTap: () => {
      toggleTreeGroupMinimized(node.id, false)
      setTreeGroupHeaderHidden(node.id, true)
    }
  }

  const dirWord: Record<RootEdge, string> = {
    bottom: t.zones.dirDown,
    left: t.zones.dirLeft,
    right: t.zones.dirRight,
    top: t.zones.dirUp
  }

  // Zone-menu directions, contextual to this group's state:
  //  - stacked panes -> "Split <dir>": carve a new zone on that side with the
  //    right-clicked chip's pane in it (split + move, one gesture);
  //  - a single pane -> "Move <dir>": join the zone visually adjacent on that
  //    side (splitting here would only make an invisible empty zone). Sides
  //    with no visible neighbor are omitted entirely.
  // A THUNK, and read with `.get()` rather than `useStore`. Every zone used to
  // subscribe to the whole layout tree just to resolve this list — so any tree
  // write (every tab activate, every drop commit, every sash release)
  // re-rendered every mounted zone, dragging each one's entire transcript with
  // it. Nothing needs the answer until the context menu actually opens, and by
  // then a fresh read is both cheaper and more correct than a subscription.
  const menuDirections = (): ZoneMenuDirection[] => {
    if (shown.length > 1) {
      return DIRECTION_ORDER.map(side => ({
        side,
        label: `${t.zones.split(dirWord[side])} ${DIRECTION_ARROW[side]}`,
        run: () => splitTreeZone(node.id, side, menuPane ?? activeId)
      }))
    }

    const tree = $layoutTree.get()

    return DIRECTION_ORDER.flatMap(side => {
      const neighbor = tree ? adjacentGroup(tree, node.id, side, g => g.panes.some(id => tileShown(id, tileCtx))) : null

      if (!neighbor || neighbor.id === node.id) {
        return []
      }

      return [
        {
          side,
          label: `${t.zones.move(dirWord[side])} ${DIRECTION_ARROW[side]}`,
          run: () => moveTreePane(activeId, { groupId: neighbor.id, pos: 'center' })
        }
      ]
    })
  }

  // Close targets the right-clicked chip (falling back to the active pane);
  // only panes that declare `uncloseable` (the main workspace) are exempt.
  const closable = () => {
    const paneId = menuPane ?? activeId

    return tileChrome(paneFor(paneId)).uncloseable ? undefined : paneId
  }

  // Any REGISTERED tile can detach — the window hosts it generically, so there
  // is no roster to keep in sync. Gated on the platform having a second window
  // (Android doesn't yet) and on the tile not already being out there.
  //
  // `uncloseable` is excluded for the same reason Close is: the main workspace
  // pane is the app's home surface, it carries whatever session is active
  // rather than one of its own, and leaving would swap it for a placeholder.
  const canDetach = (paneId: string): boolean =>
    canOpenNewWindow() && Boolean(paneFor(paneId)) && !tileChrome(paneFor(paneId)).uncloseable && !detached.has(paneId)

  const detachable = () => {
    const paneId = menuPane ?? activeId

    return canDetach(paneId) ? paneId : undefined
  }

  /** Drag a tab clear of the window to give it one of its own — the gesture
   *  form of the menu's "Open in new window", offered by exactly the panes the
   *  menu offers it to. */
  const tearOffTab = (paneId: string) => (canDetach(paneId) ? () => void detachTile(paneId) : undefined)

  // The zone hosting the uncloseable workspace never minimizes — collapsing
  // MAIN strands the whole app behind a strip.
  const minimizable = !shown.some(id => tileChrome(paneFor(id)).uncloseable)

  // Tap-to-collapse is the DetailPane gesture, and it belongs to TOOL zones
  // (terminal/files) — the panels it was written for. On a CHAT strip the empty
  // space beside the tabs is a target the user aims at constantly (reaching a
  // tab, working its menu), so a stray click there folded the whole zone away.
  // The chevron and the zone menu still minimize a chat zone deliberately.
  const tapCollapses = minimizable && shown.some(isCollapsePane)

  // Middle-click / ⌘-click / the ✕ on a tab: ONE routing for every tab kind,
  // the same one the zone menu's Close and ⌘W use — a tool panel leaves the
  // strip and syncs its toggle, everything else routes through its own Close.
  const closeTab = (paneId: string) => closeTabPane(paneId)

  // A pane whose STORE owns Close keeps the gesture even when the pane itself
  // is uncloseable — the workspace tab empties to a fresh draft rather than
  // leaving the tree.
  const closeableTab = (paneId: string) => !tileChrome(paneFor(paneId)).uncloseable || panesWithCloser.has(paneId)

  // Collapse/restore a tool panel (or plain minimize elsewhere) — the header
  // chevron + tap gesture, routed so ⌃`/the titlebar toggle stay truthful.
  const toggleCollapse = () => (node.minimized ? restoreTreePane(activeId) : collapseTreePane(activeId))

  // Same menu on the header strip and the edit veil — one prop bag.
  const zoneMenu = {
    closable,
    detachable,
    directions: menuDirections,
    headerHidden,
    menuTarget: () => menuPane ?? activeId,
    minimizable,
    minimized: node.minimized,
    nodeId: node.id
  }

  // Which zone re-rendered, by the kind of tile it is fronting. The root
  // Profiler can time the layout tree but cannot say which pane's content
  // caused a commit, and that is the difference between "a sidebar resize
  // costs a second of React" and something you can act on. Null in release.
  notifyZoneRender(node.id, active?.kind ?? 'empty')

  // NO body double-click toggle: virtualized content (the thread) recreates
  // its nodes between clicks, so the gesture was hopelessly unreliable. The
  // bar's lifecycle is explicit instead — gaining a tab sticky-shows it
  // (insertAtGroup pins headerHidden false), the main tab's context menu
  // hides it, and full-page views veto it via paneChrome.headerVeto.

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--ui-bg-editor)"
      data-tree-group={node.id}
      // Advertises the visible tab strip so panes can drop their own
      // self-naming labels (see [data-pane-self-label] in styles.css).
      data-zone-header={headerVisible || undefined}
      ref={ref}
    >
      {/* Minimized in a ROW: a narrow vertical rail — same PaneTab shell as
          the horizontal strip, just `vertical`. Click a tab to restore +
          activate; click anywhere else on the rail to restore. */}
      {verticalCollapse && (
        <ZoneMenu {...zoneMenu}>
          <div
            className={cn(
              'flex h-full w-7 shrink-0 cursor-pointer select-none flex-col items-stretch bg-(--pane-tab-strip-bg) [--pane-tab-strip-bg:var(--theme-card-seed)]',
              // Strip line faces the content the zone collapsed away from.
              railSide === 'right' ? PANE_TAB_STRIP_LINE_LEFT : PANE_TAB_STRIP_LINE_RIGHT
            )}
            onClick={() => restoreTreePane(activeId)}
            title={t.zones.restore}
          >
            <div
              className="flex min-h-0 flex-col overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="tablist"
            >
              {shown.map(paneId => {
                const closeable = closeableTab(paneId)
                const title = paneFor(paneId)?.title ?? paneId

                return (
                  <PaneTab
                    // Match the horizontal minimized strip: no tab is "active"
                    // while collapsed (there's no content surface to merge into).
                    aria-selected={paneId === activeId}
                    data-tree-tab={paneId}
                    key={paneId}
                    onClick={event => {
                      event.stopPropagation()
                      restoreTreePane(paneId)
                    }}
                    onClose={closeable ? () => closeTab(paneId) : undefined}
                    role="tab"
                    side={railSide}
                    vertical
                  >
                    <PaneTabLabel>{title}</PaneTabLabel>
                  </PaneTab>
                )
              })}
            </div>
          </div>
        </ZoneMenu>
      )}

      {/* Header: the zone's tab strip — `PaneTabStrip` + `PaneTab`, the ONE tab
          bar in the app. Session, page and preview tabs all render through it,
          so there is no second strip at a second height to drift from it. */}
      {headerVisible && (
        <ZoneMenu {...zoneMenu}>
          <PaneTabStrip
            // data-zone-tabstrip: a drop over here STACKS (drag-session reads it).
            data-zone-tabstrip={node.id}
            listRef={tabsRef}
            onContextMenu={e => {
              setMenuPane(
                (e.target as HTMLElement).closest('[data-tree-tab]')?.getAttribute('data-tree-tab') ?? undefined
              )
            }}
            onPointerDown={e =>
              // Tap the header to collapse to it / expand back — the DetailPane
              // / sidebar-section gesture (tool zones only). Double-tap hides
              // the header entirely. Drag still moves the pane.
              startPaneDrag(
                activeId,
                e,
                () => tapCollapses && toggleCollapse(),
                undefined,
                hideHeaderDoubleTap,
                active?.title ?? activeId
              )
            }
            ref={stripRef}
            style={{ cursor: 'grab' }}
            trailing={
              <>
                {/* Tools the active tile contributes, then the `+`, the chevron
                    and the caret — all OUTSIDE the scroller. Inside it they were
                    scroll content, so the moment the tabs overflowed they slid
                    off the end and reaching them meant scrolling back by hand. */}
                {stripTools.map(tool => (
                  <PaneStripGlyph
                    active={tool.active}
                    disabled={tool.disabled}
                    icon={tool.icon}
                    key={tool.id}
                    label={tool.label}
                    onSelect={tool.onSelect}
                  />
                ))}
                {/* New-tab affordance, chat strips only — the same thing ⌘T does.
                    A terminal or preview strip has its own create verb, so a `+`
                    there would be ambiguous.

                    `coarse:opacity-100`, the house rule: `opacity-0` hides a
                    button but does NOT stop it taking taps, so on a touch
                    device this was an INVISIBLE control sitting in the strip —
                    and its only other route, ⌘T, needs a keyboard. Same for the
                    minimize chevron below (its verb is at least also in the
                    long-press zone menu; "new tab" is not). */}
                {onNewTab && (
                  <Tip label={<TipKeybindLabel actionId="session.newTab" text={t.zones.newTab} />}>
                    <button
                      aria-label={t.zones.newTab}
                      className="mx-1 grid size-5 shrink-0 place-items-center self-center rounded-md text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground coarse:opacity-100 focus-visible:opacity-100 group-hover/pane-header:opacity-100"
                      onClick={onNewTab}
                      onPointerDown={e => e.stopPropagation()}
                      type="button"
                    >
                      <Codicon name="add" size="0.75rem" />
                    </button>
                  </Tip>
                )}
                {minimizable && (
                  <button
                    aria-label={node.minimized ? t.zones.restore : t.zones.minimize}
                    className="mx-1 grid size-5 shrink-0 place-items-center self-center rounded-md text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--ui-control-hover-background) hover:text-foreground coarse:opacity-100 focus-visible:opacity-100 group-hover/pane-header:opacity-100"
                    onClick={toggleCollapse}
                    onPointerDown={e => e.stopPropagation()}
                    type="button"
                  >
                    <Codicon name={node.minimized ? 'chevron-down' : 'chevron-up'} size="0.75rem" />
                  </button>
                )}
                <StripDropCaret groupId={node.id} stripRef={stripRef} />
              </>
            }
          >
            {shown.map(paneId => {
              const isActive = paneId === activeId && !node.minimized
              const chrome = tileChrome(paneFor(paneId))
              const closeable = closeableTab(paneId)
              const title = paneFor(paneId)?.title ?? paneId
              const isSelected = tabSelection?.groupId === node.id && tabSelection.ids.has(paneId)

              const tab = (
                <PaneTab
                  active={isActive}
                  aria-selected={isActive}
                  data-tree-tab={paneId}
                  key={paneId}
                  onClose={closeable ? () => closeTab(paneId) : undefined}
                  onPointerDown={e => {
                    // Chrome's tab-selection grammar, ahead of activate/drag:
                    // Shift-click ranges from the anchor, ⌥-click (Ctrl-click
                    // off-Mac) toggles. Neither activates nor starts a drag —
                    // the press IS the selection edit. ⌘-click stays close
                    // (PaneTab claims it first) and ⌃-click stays the macOS
                    // context menu.
                    if (e.button === 0 && e.shiftKey) {
                      e.preventDefault()
                      e.stopPropagation()
                      selectTabRange(node.id, shown, paneId, activeId)

                      return
                    }

                    if (isToggleSelectClick(e)) {
                      e.preventDefault()
                      e.stopPropagation()
                      toggleTabSelected(node.id, shown, paneId, activeId)

                      return
                    }

                    // Tabs ACTIVATE (restoring a collapsed group). Minimize
                    // lives on the chevron / single-pane label — overloading
                    // the active tab made double-click a minimize/restore/hide
                    // lottery. A plain click also collapses any multi-tab
                    // selection back to the one tab (Chrome semantics).
                    const onTap = () => {
                      clearTabSelection()

                      if (node.minimized) {
                        restoreTreePane(paneId)
                      }

                      activateTreePane(node.id, paneId)
                    }

                    // Claim the press so the STRIP's own pane-drag handler
                    // (parent onPointerDown) can't also fire. startPaneDrag
                    // does this internally; the session drag (shared with
                    // sidebar rows) doesn't, so do it here for both paths.
                    if (e.button === 0) {
                      e.preventDefault()
                      e.stopPropagation()
                    }

                    // Dragging a SELECTED tab carries the whole selection as
                    // one block through the generic pane move — a multi-tab
                    // drag outranks the pane's own tab drag (the session drop
                    // language is single-session).
                    const dragSelection = selectionFor(node.id, shown, paneId)

                    if (dragSelection) {
                      startPaneDrag(
                        paneId,
                        e,
                        onTap,
                        stripRef.current ? { groupId: node.id, strip: stripRef.current } : undefined,
                        hideHeaderDoubleTap,
                        t.zones.tabCount(dragSelection.length),
                        undefined,
                        dragSelection
                      )

                      return
                    }

                    // A pane may own its tab drag (a session tab speaks the
                    // session drop language — link/stack/split); `false` defers
                    // to the generic pane move (the workspace tab on a fresh
                    // draft has no session to link).
                    if (!chrome.tabDrag?.(e, onTap, hideHeaderDoubleTap)) {
                      startPaneDrag(
                        paneId,
                        e,
                        onTap,
                        stripRef.current ? { groupId: node.id, strip: stripRef.current } : undefined,
                        hideHeaderDoubleTap,
                        title,
                        tearOffTab(paneId)
                      )
                    }
                  }}
                  role="tab"
                  selected={isSelected}
                  style={{ cursor: 'grab' }}
                >
                  {/* Lead slot. A tile that contributes a NODE owns the slot
                      outright (a session tab's live status dot, which says
                      colour AND turn state); `accent` is the string-only
                      fallback for tiles that only have a colour. Both sit in
                      the same box so a strip mixing the two keeps one left
                      edge. */}
                  {chrome.tabLead ? (
                    <span className="ml-2 -mr-1 flex shrink-0 items-center">{chrome.tabLead()}</span>
                  ) : chrome.accent ? (
                    <span
                      aria-hidden="true"
                      className="ml-2 -mr-1 size-1 shrink-0 rounded-full"
                      style={{ backgroundColor: chrome.accent }}
                    />
                  ) : null}
                  <PaneTabLabel>{title}</PaneTabLabel>
                </PaneTab>
              )

              // A pane may wrap ITS tab in a domain menu (session verbs on a
              // tile tab); the wrapper needs the key since it's the root.
              return <Fragment key={paneId}>{chrome.tabWrap ? chrome.tabWrap(tab) : tab}</Fragment>
            })}
          </PaneTabStrip>
        </ZoneMenu>
      )}

      {/* Body: the active pane's contributed content, or the empty zone.
          `data-tree-body` is what the opt-in calm-while-resizing rule targets
          (styles.css): one marker on the container, not a rule per surface.

          MINIMIZE HIDES, IT DOES NOT UNMOUNT (MJXHRM-373). This used to be
          `{!node.minimized && …}`, which tore down every tile in the zone —
          not just the active one, the whole kept set. For a chat that lost the
          transcript's scroll position; for a terminal on the LOCAL transport it
          killed the shell, because `TerminalView`'s unmount cleanup invokes
          `pty_kill`. The zone renderer was making a process-lifetime decision
          on the terminal's behalf.

          Frozen at its last size and taken OUT OF FLOW rather than
          `display: none`d, for two reasons. A zero-height box would make xterm
          refit to one row and REFLOW the scrollback — destroying the thing the
          fix is meant to preserve. And `display: none` destroys the layout
          boxes, so every scroller inside snaps back to the top on restore.
          `visibility: hidden` at a fixed size keeps both, and keeps
          ResizeObserver quiet: nothing inside the zone resizes at all while it
          is folded away. */}
      {bodyMounted && (
        <div
          className={cn(
            'relative min-h-0 min-w-0 overflow-auto',
            node.minimized ? 'pointer-events-none invisible absolute top-0 left-0' : 'flex-1'
          )}
          data-tree-body
          ref={bodyRef}
          style={node.minimized ? frozenBody : undefined}
          // Marks the whole zone's contents as hidden, so the document-wide
          // "which chat surface / composer / viewport" lookups skip a folded
          // zone the way they already skip an inactive tab.
          {...hiddenPaneProps(Boolean(node.minimized))}
        >
          {isEmpty ? (
            <div className="grid h-full place-items-center">
              {/* Same decode primitive as the CONNECTING boot overlay. */}
              <DecodeText className="text-(--ui-text-quaternary)" cursor prefix={1} text="HERMES" />
            </div>
          ) : (
            keptPanes.map(paneId => {
              const tile = paneFor(paneId)
              // `shown.includes` is what keeps a KEPT-BUT-HIDDEN tile hidden:
              // with every tile in the zone toggled off, `activeId` falls back
              // to `node.active`, and without this the pane the store just hid
              // would render as the visible one.
              const isActive = paneId === activeId && shown.includes(paneId)

              return (
                <div
                  aria-hidden={!isActive || undefined}
                  // CLIP, never scroll. Every surface that can sit in a zone
                  // brings its own scroller (the transcript's viewport, the
                  // file tree, xterm, CodeMirror), so `overflow-auto` here was
                  // a second scrollbar wrapped around the first — and since
                  // WebKitGTK draws classic, space-taking bars, even a
                  // sub-pixel overflow painted a permanent one on both axes.
                  className={cn('absolute inset-0 overflow-hidden', !isActive && 'pointer-events-none invisible')}
                  key={paneId}
                  {...hiddenPaneProps(!isActive)}
                >
                  {detached.has(paneId) ? (
                    // The tile lives in another window. The SLOT stays — that is
                    // what makes reattach a restore rather than a fresh
                    // placement decision — and shows the way back.
                    <DetachedSlot paneId={paneId} title={tile?.title ?? paneId} />
                  ) : tile?.render ? (
                    // Visibility flows to the tile so a kept-alive chat surface
                    // can gate its hot (per-token) subscriptions while hidden;
                    // the group id identifies the ZONE it lives in, for state
                    // that is per-zone rather than per-tab.
                    <PaneGroupContext.Provider value={node.id}>
                      {/* A folded zone is not showing ANY of its tiles, so the
                          active one gates its hot subscriptions off too — the
                          same contract an inactive tab has always had. */}
                      <PaneVisibleContext.Provider value={isActive && !node.minimized}>
                        <PaneProfiler kind={tile.kind}>
                          {/* The reload epoch keys the CONTENT, not this layer:
                              a Reload remounts the contribution (effects re-run,
                              state resets) while the layer — and every other
                              tab — stays exactly where it was. */}
                          <ContribBoundary id={tile.id} key={paneEpochs[paneId] ?? 0}>
                            {tile.render()}
                          </ContribBoundary>
                        </PaneProfiler>
                      </PaneVisibleContext.Provider>
                    </PaneGroupContext.Provider>
                  ) : (
                    isActive && (
                      <div className="p-3 font-mono text-[11px] text-(--ui-text-quaternary)">
                        {t.zones.missingPane(paneId)}
                      </div>
                    )
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* Edit-mode veil: the BODY is a drag handle for the active pane. It
          starts below the header so tabs/headers stay directly interactive
          (drag any tab, right-click for the zone menu). */}
      {editMode && !dragging && !isEmpty && !node.minimized && (
        <ZoneMenu {...zoneMenu}>
          <div
            // z-50: pane CONTENT may carry its own stacked chrome (the
            // terminal rail is z-40) — the edit veil must cover all of it.
            // The scrim mixes the accent over the CHROME BG (not transparent)
            // so it properly dims content in dark themes instead of leaving a
            // barely-tinted wash; the light blur reads as "edit mode" the same
            // way the zone editor's backdrop does.
            className="absolute inset-x-0 bottom-0 z-50 flex cursor-grab items-center justify-center outline-1 -outline-offset-2 outline-dashed backdrop-blur-[2px]"
            onPointerDown={e => startPaneDrag(activeId, e, undefined, undefined, undefined, active?.title ?? activeId)}
            style={{
              top: headerVisible ? 28 : 0,
              background:
                'color-mix(in srgb, var(--ui-accent) 6%, color-mix(in srgb, var(--ui-bg-chrome) 55%, transparent))',
              outlineColor: 'color-mix(in srgb, var(--ui-accent) 55%, transparent)'
            }}
          >
            <span className="flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border border-(--ui-stroke-secondary) bg-popover px-2 py-1 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-(--ui-text-secondary)">
              <Codicon className="shrink-0" name="gripper" size="0.8125rem" />
              <span className="min-w-0 truncate">{active?.title ?? activeId}</span>
            </span>
          </div>
        </ZoneMenu>
      )}

      {/* FancyZones drop overlay — its own component so the per-frame drop
          hint re-renders only this (tiny) node, not the whole zone. */}
      <ZoneDropOverlay node={node} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab-strip insertion caret
// ---------------------------------------------------------------------------

/**
 * The insertion divider for a stack drop: a 2px vertical line at the slot the
 * dragged tab will land in (before `stack.before`, or after the last tab).
 * Absolute over the strip — pure overlay, zero layout shift. #000 on light,
 * #FFF on dark. Split out so per-pointermove `$dropHint` churn re-renders
 * only this node (same isolation contract as ZoneDropOverlay).
 */
function StripDropCaret({ groupId, stripRef }: { groupId: string; stripRef: RefObject<HTMLDivElement | null> }) {
  const hint = useStore($dropHint)
  const strip = stripRef.current
  const stack = hint?.groupId === groupId ? hint.stack : undefined

  if (stack === undefined || !strip) {
    return null
  }

  // Slot x: the before-tab's left edge, or the last tab's right edge.
  const tabs = [...strip.querySelectorAll<HTMLElement>('[data-tree-tab]')]
  const target = stack.before ? tabs.find(el => el.dataset.treeTab === stack.before) : tabs.at(-1)

  if (!target) {
    return null
  }

  const stripRect = strip.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const x = (stack.before ? targetRect.left : targetRect.right) - stripRect.left

  // A short centered tick (~60% of the tab), not a full-height wall — reads
  // as an insertion point between labels, browser-tab style.
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute z-50 w-px -translate-x-1/2 bg-black dark:bg-white"
      style={{
        height: targetRect.height * 0.6,
        left: x,
        top: targetRect.top - stripRect.top + targetRect.height * 0.2
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// FancyZones drop overlay
// ---------------------------------------------------------------------------

/** Overlay entry fade. FancyZones ships 200ms (FADE_IN_DURATION_MILLIS in
 *  zones-engine); on a drag that starts under the cursor that ramp reads as
 *  lag, so the sheets snap in far faster — same softening, instant feel. */
const OVERLAY_FADE_MS = 80

/** Sheet inset from the zone edge (px). */
const REGION_PAD = 6

/** The sheet's box per drop position — longhand insets so CSS transitions can
 *  interpolate the px↔% change: the target GLIDES between the full zone and
 *  the hovered half instead of snapping (VS Code dock preview). */
const REGION: Record<DropPosition, CSSProperties> = {
  bottom: { bottom: REGION_PAD, left: REGION_PAD, right: REGION_PAD, top: '50%' },
  center: { bottom: REGION_PAD, left: REGION_PAD, right: REGION_PAD, top: REGION_PAD },
  left: { bottom: REGION_PAD, left: REGION_PAD, right: '50%', top: REGION_PAD },
  right: { bottom: REGION_PAD, left: '50%', right: REGION_PAD, top: REGION_PAD },
  top: { bottom: '50%', left: REGION_PAD, right: REGION_PAD, top: REGION_PAD }
}

/**
 * The FancyZones drop overlay for one zone. Split out of TreeGroup so the
 * per-pointermove `$dropHint` churn re-renders only this lightweight node —
 * the zone's header, body, and menu-direction walk stay put during a drag.
 *
 * ONE dashed sheet per zone (DROP_SHEET_CLASS — the composer drop and the zone
 * targets speak identically): a quiet outline over every eligible zone,
 * accent-lit over the target, morphing to the hovered half for an edge split.
 */
function ZoneDropOverlay({ node }: { node: GroupNode }) {
  const dragging = useStore($treeDragging)
  const hint = useStore($dropHint)
  const byId = useTileMap()

  if (dragging === null) {
    return null
  }

  // A session drag (sidebar row) reuses this exact overlay — over ANY zone
  // now (stack into its tabs / split its edges); only a CHAT zone's center is
  // a link-to-chat (the composer overlay owns that visual).
  const sessionDrag = dragging === SESSION_TILE_DRAG
  // Declared, not inferred from the id: a tile says whether a dragged session
  // may be LINKED into its zone (`chrome.linkTarget`). This used to be
  // `node.panes.some(isChatPaneId)` — the layout engine reading a chat id
  // prefix to decide a drop affordance.
  const linkZone = node.panes.some(id => tileChrome(byId.get(id)).linkTarget)

  const isDragSource = node.panes.includes(dragging)

  // The source zone, when it holds only the dragged pane, has nothing to drop.
  if (isDragSource && node.panes.length === 1) {
    return null
  }

  const primary = hint?.groupId === node.id

  // Hovering the target's TAB STRIP: the insertion caret (StripDropCaret)
  // owns the affordance — the zone sheet stands down so the two never stack.
  if (primary && hint?.stack !== undefined) {
    return null
  }

  const active = hint?.groupIds?.includes(node.id) ?? false
  const multi = (hint?.groupIds?.length ?? 0) > 1
  // Sub-positions only exist for a single-zone target (a Shift-span merges).
  const pos = primary && !multi ? (hint?.pos ?? 'center') : 'center'
  // Session drag over a CHAT zone's CENTER: the "link to chat" overlay inside
  // the surface (ChatDropOverlay — the same sheet) owns that region; this sheet
  // fades out so the two never stack. A non-chat zone's center has no chat to
  // link, so it shows the normal stack sheet. Edges act like a tab.
  const centerLink = sessionDrag && primary && pos === 'center' && linkZone

  return (
    <div
      className="pointer-events-none absolute inset-0 z-40"
      style={{ animation: `hermes-zone-fade ${OVERLAY_FADE_MS}ms linear both` }}
    >
      <div
        className={cn(
          DROP_SHEET_CLASS,
          // Transition ONLY the box + colors. `transition-all` also animated
          // backdrop-filter, and a blur interpolating while the insets glide
          // re-blurs half a zone every frame — the single most expensive
          // paint in the whole drag.
          'absolute transition-[top,right,bottom,left,background-color,border-color,opacity] duration-150 ease-out',
          // Blur only the live target — idle outlines must not fog the app.
          active && !centerLink && DROP_SHEET_BLUR_CLASS,
          centerLink && 'opacity-0'
        )}
        style={{
          ...REGION[pos],
          // Accent over a card wash so the fill dims content on dark themes
          // (a bare accent alpha disappears there).
          background: active
            ? 'color-mix(in srgb, var(--ui-accent) 18%, color-mix(in srgb, var(--dt-card) 55%, transparent))'
            : 'color-mix(in srgb, var(--ui-accent) 5%, color-mix(in srgb, var(--dt-card) 25%, transparent))',
          borderColor: `color-mix(in srgb, var(--ui-accent) ${active ? 75 : 28}%, transparent)`
        }}
      />
    </div>
  )
}
