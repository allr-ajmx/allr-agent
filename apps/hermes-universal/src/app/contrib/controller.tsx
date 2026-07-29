import '@/store/session-tile-delegate' // side-effect: registers the SessionTileDelegate

import { computed } from 'nanostores'
import { type ReactElement, useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { IdleMount } from '@/components/idle-mount'
import { allPaneIds, group, split } from '@/components/pane-shell/tree/model'
import { LayoutTreeRoot } from '@/components/pane-shell/tree/renderer'
import {
  $layoutTree,
  bindTreeSideVisibility,
  declareDefaultTree,
  dismissTreePane,
  dockPaneBeside,
  markCollapsePane,
  mirrorLayoutTree,
  paneRootSide,
  registerLayoutResetHandler,
  registerPaneCloser,
  registerPaneOpener,
  revealTreePane,
  setPaneCollapsed,
  setTreePaneHidden,
  watchContributedPanes
} from '@/components/pane-shell/tree/store'
import { discoverBundledPlugins } from '@/contrib/plugins'
import { registry } from '@/contrib/registry'
import { sessionTitle as storedSessionTitle } from '@/lib/chat-runtime'
import { $currentCwd } from '@/store/chat'
import { $chatBubbles, bubbleRuntimeKey } from '@/store/chat-bubbles'
import { routeGatewayEvent } from '@/store/event-router'
import { $gatewayState, addGatewayEventListener } from '@/store/gateway'
import {
  $panesFlipped,
  $rightSidebarOpen,
  $sidebarOpen,
  $terminalOpen,
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MAX_WIDTH,
  FILE_TREE_MIN_WIDTH,
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_MAX_WIDTH,
  PREVIEW_MIN_WIDTH,
  setSidebarOpen,
  setTerminalOpen,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH
} from '@/store/layout'
import { $previewTabs, closeAllPreviewTabs } from '@/store/preview'
import { $reviewOpen, closeReview, REVIEW_PANE_ID } from '@/store/review'
import { $activeStoredSessionId, $sessions, sessionMatchesStoredId } from '@/store/session'
import { $sessionColorById, sessionColorFor } from '@/store/session-color'
import { invalidateRuntimeBindings, setVisibleBubbleKeysProvider } from '@/store/session-states'

import {
  SessionTileCloseConfirm,
  stackSessionTilesIntoMain,
  watchSessionTiles,
  WorkspaceTabMenu
} from '../chat/session-tile'
import { ChatSidebar } from '../chat/sidebar'
import { $workspaceIsPage, syncWorkspaceIsPage } from '../routes'

import { FilesPane, PreviewRailPane, ReviewPaneContent, TerminalPane, WorkspaceRoutes } from './panes'

/**
 * Layout-tree contribution root (ported from desktop's `app/contrib/
 * controller.tsx`). Every workspace surface — the chat sidebar, the routed
 * chat/pages, files, preview, review, terminal — is registered as a
 * `area:'panes'` contribution; the layout tree stores only pane ids and
 * resolves content from the registry. `ContribController` renders the tree.
 *
 * Universal differences from desktop:
 *  - The titlebar and statusbar are NOT rendered here — universal keeps its own
 *    `Titlebar`/`Statusbar` in MobileController (Phase 8 makes them
 *    focused-session-aware). This file owns only the workspace grid.
 *  - Surfaces are self-wired, so panes render their components directly (no
 *    `WiredPane`/`WiringActions` indirection).
 *  - FIXME(MJX-50/palette-bridge): desktop registers `layout.editMode` /
 *    `layout.reset` / `plugins.reload` command-PALETTE rows; universal has a
 *    command-MENU, not a palette, so those rows are omitted here.
 *  - FIXME(MJX-51): the FancyZones structural-authoring UI is deferred; the
 *    four presets below are read-only.
 */

// ONE render identity for the workspace pane — syncWorkspaceTitle re-registers
// the contribution (new title) and a fresh closure would remount the chat. The
// anchor div carries `data-session-anchor="workspace"` so geometry.ts can
// publish --workspace-left/right from the main zone's edges.
// h-full (NOT flex-1): the TreeGroup pane body (tree-group.tsx) is a non-flex
// `overflow-auto` container, so a `flex-1` child is inert and collapses to
// content height — the chat then grows unbounded and the body scrolls it
// (messages stuck at the bottom). The body HAS a definite height, so `h-full`
// gives `.chat` (flex:1 1 auto, needs a bounded flex-col parent) real room to
// fill and scroll its own thread internally.
const renderWorkspacePane = () => (
  <div className="flex h-full min-h-0 min-w-0 flex-col" data-composer-target="main" data-session-anchor="workspace">
    <WorkspaceRoutes />
  </div>
)

// The workspace tab carries the loaded session's context menu — same verbs as a
// tile tab, so main + tiles read as one row of session tabs.
const wrapWorkspaceTab = (tab: ReactElement) => <WorkspaceTabMenu>{tab}</WorkspaceTabMenu>

// Boot-hidden panes mount behind display:none (instant-toggle contract) — defer
// them to idle so they're off the first-paint path, warm before reveal.
const idle = (node: ReactElement) => <IdleMount>{node}</IdleMount>

registry.registerMany([
  {
    id: 'sessions',
    area: 'panes',
    title: 'sessions',
    // Collapsible: leaves the grid on narrow viewports (edge overlay instead).
    // dock: where a RE-ADOPTED pane lands (healed from a stale dismissal).
    data: {
      placement: 'left',
      collapsible: true,
      dock: { pane: 'workspace', pos: 'left' },
      revealAliases: ['chat-sidebar'],
      width: `${SIDEBAR_DEFAULT_WIDTH}px`,
      minWidth: `${SIDEBAR_DEFAULT_WIDTH}px`,
      maxWidth: `${SIDEBAR_MAX_WIDTH}px`
    },
    render: () => <ChatSidebar variant="pane" />
  },
  {
    id: 'workspace',
    area: 'panes',
    // Live-retitled to the loaded session by syncWorkspaceTitle below.
    title: 'New session',
    data: { placement: 'main', minWidth: '22vw', tabWrap: wrapWorkspaceTab, uncloseable: true },
    render: renderWorkspacePane
  },
  {
    id: 'terminal',
    area: 'panes',
    title: 'terminal',
    // A single-pane zone declaring a height is a FIXED track (a short deck, not
    // a third of the window). revealOnPreset: a layout that places the terminal
    // turns it on so the zone shows instead of staying collapsed behind ⌃`.
    data: { placement: 'bottom', height: '20vh', minHeight: '7.5rem', maxHeight: '80vh', revealOnPreset: true },
    render: () => <TerminalPane />
  },
  {
    id: 'files',
    area: 'panes',
    title: 'files',
    data: {
      placement: 'right',
      collapsible: true,
      dock: { pane: 'workspace', pos: 'right' },
      revealAliases: ['file-tree', 'file-browser'],
      width: `${FILE_TREE_DEFAULT_WIDTH}px`,
      minWidth: `${FILE_TREE_MIN_WIDTH}px`,
      maxWidth: `${FILE_TREE_MAX_WIDTH}px`
    },
    render: () => idle(<FilesPane />)
  },
  {
    id: 'preview',
    area: 'panes',
    title: 'preview',
    // Exists only while something is previewed — visibility is bound to the
    // preview tabs below. dock: adoption seed only — dockPaneBeside re-docks it
    // next to files on every reveal anyway (position-aware).
    data: {
      placement: 'right',
      dock: { pane: 'files', pos: 'left' },
      width: `${PREVIEW_DEFAULT_WIDTH}px`,
      minWidth: `${PREVIEW_MIN_WIDTH}px`,
      maxWidth: `${PREVIEW_MAX_WIDTH}px`
    },
    render: () => idle(<PreviewRailPane />)
  },
  {
    id: 'review',
    area: 'panes',
    title: 'review',
    // The git-diff sidebar: hidden until ⌘G ($reviewOpen); its zone collapses
    // while hidden.
    data: {
      placement: 'right',
      collapsible: true,
      revealAliases: [REVIEW_PANE_ID],
      width: `${FILE_TREE_DEFAULT_WIDTH}px`,
      minWidth: `${FILE_TREE_MIN_WIDTH}px`,
      maxWidth: `${FILE_TREE_MAX_WIDTH}px`
    },
    render: () => idle(<ReviewPaneContent />)
  }
])

// ---------------------------------------------------------------------------
// Layout presets — CHAT (main) always dominates. Read-only (FIXME(MJX-51) for
// custom save/delete). Same shape as desktop minus the optional `logs` pane
// (not ported to universal).
// ---------------------------------------------------------------------------

const DEFAULT_TREE = split(
  'row',
  [
    group(['sessions'], { id: 'grp-sessions' }),
    group(['workspace'], { id: 'grp-main' }),
    split(
      'column',
      [
        split(
          'row',
          [
            group(['review'], { id: 'grp-review' }),
            group(['preview'], { id: 'grp-preview' }),
            group(['files'], { id: 'grp-files' })
          ],
          [1, 1, 1.2],
          'spl-rail'
        ),
        group(['terminal'], { id: 'grp-terminal' })
      ],
      [1.6, 1],
      'spl-right'
    )
  ],
  [1, 3.4, 1.25],
  'spl-root'
)

const FOCUS_TREE = split(
  'row',
  [group(['sessions']), group(['workspace', 'files', 'preview', 'review', 'terminal'])],
  [1, 4.6]
)

const TERMINAL_TREE = split(
  'column',
  [
    split('row', [group(['sessions']), group(['workspace']), group(['files', 'preview', 'review'])], [1, 3.2, 1.2]),
    group(['terminal'])
  ],
  [3, 1]
)

const QUAD_TREE = split(
  'column',
  [
    split('row', [group(['sessions', 'files']), group(['workspace'])], [1, 3]),
    split('row', [group(['terminal']), group(['preview', 'review'])], [1.4, 1])
  ],
  [3, 1]
)

registry.registerMany([
  { id: 'default', area: 'layouts', title: 'Default', order: 0, data: DEFAULT_TREE },
  { id: 'focus', area: 'layouts', title: 'Focus', order: 10, data: FOCUS_TREE },
  { id: 'terminal-deck', area: 'layouts', title: 'Terminal deck', order: 20, data: TERMINAL_TREE },
  { id: 'quad', area: 'layouts', title: 'Quad', order: 30, data: QUAD_TREE }
])

declareDefaultTree(DEFAULT_TREE)

// Bundled plugins load AFTER core (no-op stub on universal — FIXME(MJX-50/plugins)).
discoverBundledPlugins()

// Plugin panes (and any contributed pane) join the tree by their `placement`
// hint the moment they register.
watchContributedPanes()

// THE gateway event router — one consumer for every session (the chat on
// screen, tiles, mobile bubbles). Registered here rather than imported by
// store/gateway.ts, which must stay free of the session-states/profile graph:
// a static import there reorders module init and trips the `@/hermes`
// `_apiProfile` TDZ cycle in tests.
//
// Also mirrors `$sessionTiles` into layout-tree panes and collapses tiles into
// the workspace on a layout reset.
// FIXME(MJX-50/route-tiles): page (route) tiles — watchRouteTiles() — are a follow-up.
addGatewayEventListener(routeGatewayEvent)
watchSessionTiles()

// A reconnect issues new runtime ids, so every binding we hold is dead. Drop
// the bindings (NOT the sessions — a draft's unsent text is the one thing that
// cannot be re-fetched) and let each visible surface re-resume its own session.
let wasGatewayOpen = $gatewayState.get() === 'open'

$gatewayState.subscribe(state => {
  const isOpen = state === 'open'

  if (isOpen && !wasGatewayOpen) {
    invalidateRuntimeBindings()
  }

  wasGatewayOpen = isOpen
})

// The bubble strip's sessions are on screen on mobile, so the LRU must not
// evict them. Registered here rather than imported by session-states, which
// chat-bubbles already depends on.
setVisibleBubbleKeysProvider(() =>
  $chatBubbles
    .get()
    .map(bubble => bubbleRuntimeKey(bubble.storedSessionId))
    .filter((key): key is string => Boolean(key))
)
registerLayoutResetHandler(stackSessionTilesIntoMain)

// The main tab reads as its SESSION (the loaded title, "New session" on a fresh
// draft). register() replaces same-id in place; the render fn is the shared
// constant above, so the pane content never remounts.
const syncWorkspaceTitle = () => {
  const selected = $activeStoredSessionId.get()
  const stored = selected ? $sessions.get().find(s => sessionMatchesStoredId(s, selected)) : null

  registry.register({
    id: 'workspace',
    area: 'panes',
    title: stored ? storedSessionTitle(stored) : 'New session',
    data: {
      // The tab's lead dot — same shared map the sidebar row reads, so the main
      // tab and its sidebar row always show the same color.
      accent: sessionColorFor(stored),
      // Pages aren't tab-able: the main zone's bar stands down while one shows.
      headerVeto: $workspaceIsPage.get(),
      placement: 'main',
      minWidth: '22vw',
      tabWrap: wrapWorkspaceTab,
      uncloseable: true
    },
    render: renderWorkspacePane
  })
}

$activeStoredSessionId.listen(syncWorkspaceTitle)
$sessions.listen(syncWorkspaceTitle)
$sessionColorById.listen(syncWorkspaceTitle)
$workspaceIsPage.listen(syncWorkspaceTitle)

// ---------------------------------------------------------------------------
// Titlebar toggles → tree. Universal's titlebar buttons keep their store
// semantics ($sidebarOpen / $rightSidebarOpen / $panesFlipped); the tree
// reacts — a hidden pane's zone collapses (content stays mounted), the flip
// toggle mirrors the root row.
// ---------------------------------------------------------------------------

function bindPaneVisibility(
  paneId: string,
  $open: { get(): boolean; listen(fn: (open: boolean) => void): void },
  close?: () => void,
  open?: () => void
) {
  setTreePaneHidden(paneId, !$open.get())
  $open.listen(isOpen => setTreePaneHidden(paneId, !isOpen))

  if (close) {
    registerPaneCloser(paneId, close)
  }

  if (open) {
    registerPaneOpener(paneId, open)
  }
}

// TOOL PANELS (terminal): the toggle COLLAPSES the zone to a persistent rail
// (tab stays) instead of hiding it — the IntelliJ/VS-Code tool-window model.
function bindPaneCollapse(
  paneId: string,
  $open: { get(): boolean; listen(fn: (open: boolean) => void): void },
  close: () => void,
  open: () => void
) {
  markCollapsePane(paneId)
  setPaneCollapsed(paneId, !$open.get())
  $open.listen(isOpen => setPaneCollapsed(paneId, !isOpen))
  registerPaneCloser(paneId, close)
  registerPaneOpener(paneId, open)
}

// SIDES have one source of truth: the TREE. The legacy $panesFlipped flag is
// DERIVED from where the sessions zone actually sits, so dragging sessions
// across — or applying a mirrored preset — remaps the flip automatically. The
// flip action mirrors the tree only when they disagree.
const sessionsOnRight = () => {
  const tree = $layoutTree.get()

  if (!tree) {
    return null
  }

  const order = allPaneIds(tree)
  const sessions = order.indexOf('sessions')
  const main = order.indexOf('workspace')

  return sessions >= 0 && main >= 0 ? sessions > main : null
}

$layoutTree.subscribe(() => {
  const flipped = sessionsOnRight()

  if (flipped !== null && flipped !== $panesFlipped.get()) {
    $panesFlipped.set(flipped)
  }
})

$panesFlipped.listen(flipped => {
  const current = sessionsOnRight()

  if (current !== null && current !== flipped) {
    mirrorLayoutTree()
  }
})

// POSITIONAL side toggles: $sidebarOpen ≙ the LEFT side of the main zone,
// $rightSidebarOpen ≙ the RIGHT — everything on that side hides together,
// whatever panes have been rearranged there.
bindTreeSideVisibility('left', $sidebarOpen, setSidebarOpen)
bindTreeSideVisibility('right', $rightSidebarOpen, open => $rightSidebarOpen.set(open))

// Workspace-scoped surfaces: the file tree + git diff only mean something
// inside a project. A detached chat (no cwd) hides them. The terminal is NOT
// workspace-gated: its zone stands on its own.
const $hasWorkspace = computed($currentCwd, cwd => Boolean(cwd.trim()))

bindPaneVisibility('files', $hasWorkspace)
// ⌘G — the review sidebar appears/disappears (and comes to the front).
bindPaneVisibility(
  'review',
  computed([$reviewOpen, $hasWorkspace], (open, workspace) => open && workspace),
  closeReview
)
// ⌃` / statusbar toggle — the terminal COLLAPSES to a rail (tab stays), not
// hides; PTYs stay alive while collapsed.
bindPaneCollapse(
  'terminal',
  $terminalOpen,
  () => setTerminalOpen(false),
  () => setTerminalOpen(true)
)

// Preview EXISTS only while something is previewed (closing the last preview
// tab closes the pane; a new target opens + fronts it).
const $previewVisible = computed($previewTabs, tabs => tabs.length > 0)

bindPaneVisibility('preview', $previewVisible, closeAllPreviewTabs)

// Sessions/files Close = collapse their SIDE — but only while the pane actually
// lives in that root side column. Dragged next to main, a side collapse can't
// hide it, so Close falls back to dismissal there.
registerPaneCloser('sessions', () =>
  paneRootSide('sessions') === 'left' ? setSidebarOpen(false) : dismissTreePane('sessions')
)
registerPaneCloser('files', () =>
  paneRootSide('files') === 'right' ? $rightSidebarOpen.set(false) : dismissTreePane('files')
)

// A preview target lands NEXT TO the file tree — position-aware: wherever files
// currently lives, the preview zone docks directly beside it. Then reveal: open
// the side, unhide, front.
const revealPreview = () => {
  dockPaneBeside('preview', 'files')
  revealTreePane('preview')
}

$previewTabs.listen(tabs => tabs.length > 0 && revealPreview())

/**
 * The workspace grid: mounts the layout tree. Publishes `$workspaceIsPage` from
 * the router location so the workspace tab's header vetoes on full pages.
 */
export function ContribController() {
  const { pathname } = useLocation()

  useEffect(() => {
    syncWorkspaceIsPage(pathname)
  }, [pathname])

  // LayoutTreeRoot is `flex flex-1` — it fills a flex COLUMN with a real height
  // (desktop wraps it in `flex h-screen flex-col`). MobileController hosts us in
  // a plain block `min-h-0 flex-1` div, so without this flex-column wrapper the
  // tree collapses to the chat's content height instead of filling the window.
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <LayoutTreeRoot />
      {/* "Close running tab?" — the busy/input-blocked tile close gate. */}
      <SessionTileCloseConfirm />
    </div>
  )
}
