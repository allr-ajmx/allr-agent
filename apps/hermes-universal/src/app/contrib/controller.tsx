import '@/store/session-tile-delegate' // side-effect: registers the SessionTileDelegate
import '@/store/start-work-session' // side-effect: composer branch-off → new session in the worktree

import { computed } from 'nanostores'
import { type ReactElement, useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { composerTargetForPane, markActiveComposer } from '@/app/chat/composer/focus'
import { PALETTE_AREA, type PaletteContribution, paletteToggle } from '@/app/command-palette/contrib'
import { IdleMount } from '@/components/idle-mount'
import { $layoutEditMode, toggleLayoutEditMode } from '@/components/pane-shell/edit-mode'
import { registerTile, registerTiles } from '@/components/pane-shell/tile/registry'
import { allPaneIds, group, split } from '@/components/pane-shell/tree/model'
import { LAYOUTS_AREA } from '@/components/pane-shell/tree/presets'
import { LayoutTreeRoot } from '@/components/pane-shell/tree/renderer'
import {
  $layoutTree,
  bindTreeSideVisibility,
  declareDefaultTree,
  dismissTreePane,
  mirrorLayoutTree,
  paneRootSide,
  registerLayoutResetHandler,
  registerPaneCloser,
  registerPaneOpener,
  resetLayoutTree,
  setPaneCollapsed,
  setTreePaneHidden,
  watchContributedPanes
} from '@/components/pane-shell/tree/store'
import { discoverBundledPlugins } from '@/contrib/plugins'
import { registry } from '@/contrib/registry'
import { discoverRuntimePlugins } from '@/contrib/runtime-loader'
import { translateNow } from '@/i18n'
import { sessionTitle as storedSessionTitle } from '@/lib/chat-runtime'
import { LayoutDashboard, PanelBottom, Plug } from '@/lib/icons'
import { type KeybindContribution, KEYBINDS_AREA } from '@/lib/keybinds/actions'
import { WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { IS_MOBILE } from '@/lib/platform'
import { $chatBubbles, addBubble, bubbleRuntimeKey } from '@/store/chat-bubbles'
import { $gatewayState } from '@/store/gateway'
import {
  $panesFlipped,
  $rightSidebarOpen,
  $sidebarOpen,
  $terminalOpen,
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MAX_WIDTH,
  FILE_TREE_MIN_WIDTH,
  setSidebarOpen,
  setTerminalOpen,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH
} from '@/store/layout'
import { startNewSession, startNewSessionTab } from '@/store/new-session'
import { $reviewOpen, closeReview, REVIEW_PANE_ID } from '@/store/review'
import { $activeStoredSessionId, openSession, setBranchedSessionOpener } from '@/store/session'
import { SESSION_ROW_SOURCES, sessionRowFor } from '@/store/session-lookup'
import {
  $focusedChatPane,
  closeSessionTile,
  focusWorkspaceSession,
  invalidateRuntimeBindings,
  nextSessionTileForWorkspace,
  openSessionTile,
  setVisibleBubbleKeysProvider
} from '@/store/session-states'
import { $statusbarVisible } from '@/store/statusbar-prefs'
import { $effectiveCwd, ensureWorkspaceCwd } from '@/store/workspace-events'

import { watchPreviewTiles } from '../chat/preview-tile'
import { watchRouteTiles } from '../chat/route-tile'
import { SessionStatusDot } from '../chat/session-status-dot'
import {
  SessionTileCloseConfirm,
  stackSessionTilesIntoMain,
  watchSessionTiles,
  WorkspaceTabMenu
} from '../chat/session-tile'
import { ChatSidebar } from '../chat/sidebar'
import { $workspacePage, isWorkspacePagePath, syncWorkspacePage } from '../routes'

import { FilesPane, ReviewPaneContent, TerminalPane, WorkspaceRoutes } from './panes'

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
 *  - The command rows (`layout.editMode`, `layout.reset`, `plugins.reload`) are
 *    `palette` contributions, and `layout.editMode` is also a rebindable
 *    `keybinds` contribution — the same declarative surfaces a plugin uses.
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

registerTiles([
  {
    id: 'sessions',
    kind: 'sessions',
    title: 'sessions',
    placement: 'left',
    // Collapsible: leaves the grid on narrow viewports (edge overlay instead).
    // dock: where a RE-ADOPTED tile lands (healed from a stale dismissal).
    chrome: {
      collapsible: true,
      dock: { pane: 'workspace', pos: 'left' },
      revealAliases: ['chat-sidebar']
    },
    sizing: {
      width: `${SIDEBAR_DEFAULT_WIDTH}px`,
      minWidth: `${SIDEBAR_DEFAULT_WIDTH}px`,
      maxWidth: `${SIDEBAR_MAX_WIDTH}px`
    },
    render: () => <ChatSidebar variant="pane" />
  },
  {
    id: 'workspace',
    kind: 'chat',
    // Live-retitled to the loaded session by syncWorkspaceTitle below.
    title: 'New session',
    placement: 'main',
    chrome: { linkTarget: true, tabWrap: wrapWorkspaceTab, uncloseable: true },
    sizing: { minWidth: '22vw' },
    // The `+` on the strip this tile sits in: another chat.
    onNewTab: startNewSessionTab,
    render: renderWorkspacePane
  },
  {
    id: 'terminal',
    kind: 'terminal',
    title: 'terminal',
    placement: 'bottom',
    // toolPanel: its toggle collapses the zone to a rail instead of hiding it,
    // and its ✕ removes it from the layout (⌃` brings it back).
    // revealOnPreset: a layout that places the terminal turns it on so the zone
    // shows instead of staying collapsed behind ⌃`.
    chrome: { revealOnPreset: true, toolPanel: true },
    // A single-tile zone declaring a height is a FIXED track (a short deck, not
    // a third of the window).
    sizing: { height: '20vh', minHeight: '7.5rem', maxHeight: '80vh' },
    render: () => <TerminalPane />
  },
  {
    id: 'files',
    kind: 'files',
    title: 'files',
    placement: 'right',
    chrome: {
      collapsible: true,
      dock: { pane: 'workspace', pos: 'right' },
      revealAliases: ['file-tree', 'file-browser']
    },
    sizing: {
      width: `${FILE_TREE_DEFAULT_WIDTH}px`,
      minWidth: `${FILE_TREE_MIN_WIDTH}px`,
      maxWidth: `${FILE_TREE_MAX_WIDTH}px`
    },
    render: () => idle(<FilesPane />)
  },
  {
    id: 'review',
    kind: 'review',
    title: 'review',
    placement: 'right',
    // The git-diff sidebar: hidden until ⌘G ($reviewOpen); its zone collapses
    // while hidden.
    chrome: { collapsible: true, revealAliases: [REVIEW_PANE_ID] },
    sizing: {
      width: `${FILE_TREE_DEFAULT_WIDTH}px`,
      minWidth: `${FILE_TREE_MIN_WIDTH}px`,
      maxWidth: `${FILE_TREE_MAX_WIDTH}px`
    },
    render: () => idle(<ReviewPaneContent />)
  }
])

// ---------------------------------------------------------------------------
// Layout presets — CHAT (main) always dominates. These BUILT-IN presets are
// read-only; custom save/delete shipped and lives in `tree/presets.ts`
// (`saveCurrentLayoutAs` / `deleteUserPreset`). Same shape as desktop minus the
// optional `logs` pane (not ported to universal).
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
          [group(['review'], { id: 'grp-review' }), group(['files'], { id: 'grp-files' })],
          [1, 1.2],
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

// No `preview` slot in any preset: a preview is a TILE now, one pane per open
// file, docked beside main when it opens (see app/chat/preview-tile.tsx). A
// preset can't reserve a slot for a pane that doesn't exist until you open one.
const FOCUS_TREE = split('row', [group(['sessions']), group(['workspace', 'files', 'review', 'terminal'])], [1, 4.6])

const TERMINAL_TREE = split(
  'column',
  [
    split('row', [group(['sessions']), group(['workspace']), group(['files', 'review'])], [1, 3.2, 1.2]),
    group(['terminal'])
  ],
  [3, 1]
)

const QUAD_TREE = split(
  'column',
  [
    split('row', [group(['sessions', 'files']), group(['workspace'])], [1, 3]),
    split('row', [group(['terminal']), group(['review'])], [1.4, 1])
  ],
  [3, 1]
)

// The bundled templates. User-saved presets join the same area from presets.ts
// (source: 'user'), which is also where save/delete/persist live.
registry.registerMany([
  { id: 'default', area: LAYOUTS_AREA, title: 'Default', order: 0, data: DEFAULT_TREE },
  { id: 'focus', area: LAYOUTS_AREA, title: 'Focus', order: 10, data: FOCUS_TREE },
  { id: 'terminal-deck', area: LAYOUTS_AREA, title: 'Terminal deck', order: 20, data: TERMINAL_TREE },
  { id: 'quad', area: LAYOUTS_AREA, title: 'Quad', order: 30, data: QUAD_TREE }
])

declareDefaultTree(DEFAULT_TREE)

registry.registerMany([
  // Layout edit mode registers through the SAME declarative surfaces plugins
  // use: a rebindable keybind (collision-checked in the settings panel) and a
  // command row whose hint tracks the live binding. Without them the mode has
  // no door — the palette it opens is the only way to author a layout.
  {
    area: KEYBINDS_AREA,
    data: {
      defaults: ['mod+shift+\\'],
      id: 'layout.editMode',
      label: 'Toggle layout edit mode',
      run: toggleLayoutEditMode
    } satisfies KeybindContribution,
    id: 'layout.editMode'
  },
  paletteToggle({
    action: 'layout.editMode',
    get: () => $layoutEditMode.get(),
    icon: LayoutDashboard,
    id: 'layout.editMode',
    keywords: ['layout', 'zones', 'panes', 'edit', 'rearrange'],
    label: 'Toggle layout edit mode',
    set: enabled => $layoutEditMode.set(enabled)
  }),
  {
    area: PALETTE_AREA,
    data: {
      icon: LayoutDashboard,
      id: 'layout.reset',
      keywords: ['layout', 'reset', 'default', 'panes'],
      label: 'Reset layout',
      run: resetLayoutTree
    } satisfies PaletteContribution,
    id: 'layout.reset'
  },
  // Hiding the bar removes the surface that would otherwise offer it back, so
  // the command menu is the guaranteed door in (alongside the rebindable ⌘⇧S).
  paletteToggle({
    action: 'view.toggleStatusbar',
    get: () => $statusbarVisible.get(),
    icon: PanelBottom,
    id: 'view.toggleStatusbar',
    keywords: ['status bar', 'statusbar', 'bottom bar', 'hide', 'show', 'chrome'],
    label: 'Toggle status bar',
    set: enabled => $statusbarVisible.set(enabled)
  }),
  // The manual rescan door, for when the poll's cadence isn't enough (or the
  // gateway door skipped content-diffing because the tree is large).
  {
    area: PALETTE_AREA,
    data: {
      icon: Plug,
      id: 'plugins.reload',
      keywords: ['plugin', 'rescan', 'reload'],
      // A key, not a string: the row is registered once at boot, and a literal
      // would keep the boot locale's wording after a language switch.
      labelKey: 'settings.plugins.rescan',
      run: discoverRuntimePlugins
    } satisfies PaletteContribution,
    id: 'plugins.reload'
  }
])

// Bundled plugins load AFTER core, so a plugin can override a same-id core
// contribution. This also starts the disk door's watcher (contrib/plugins.ts →
// watchRuntimePlugins), which is what makes an agent's write→see loop work.
discoverBundledPlugins()

// Plugin panes (and any contributed pane) join the tree by their `placement`
// hint the moment they register.
watchContributedPanes()

// Mirror `$sessionTiles` into layout-tree panes and collapse tiles into the
// workspace on a layout reset. Page (route) tiles and PREVIEW tiles ride the
// same mirror, keyed by path instead of session id. (Tile sessions stream off
// the shared gateway stream: THE event router self-registers on import — see
// store/event-router.ts.)
watchSessionTiles()
watchRouteTiles()
watchPreviewTiles()

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

// Branching the OPEN chat opens the branch BESIDE it and fronts it, leaving the
// parent exactly where it was — the same placement `SessionTileDelegate`
// already gives a branch made from a tab, now shared by the one made from an
// assistant message. Registered here for the same reason as the provider above:
// `store/session` cannot import tiles or bubbles without a cycle, and this is
// the layer that knows which of the two this platform has.
setBranchedSessionOpener(storedSessionId => {
  if (IS_MOBILE) {
    addBubble(storedSessionId)
  } else {
    openSessionTile(storedSessionId, 'center')
  }
})

registerLayoutResetHandler(stackSessionTilesIntoMain)

// The main tab reads as its SESSION (the loaded title, "New session" on a fresh
// draft). register() replaces same-id in place; the render fn is the shared
// constant above, so the pane content never remounts.
const syncWorkspaceTitle = () => {
  const selected = $activeStoredSessionId.get()
  // The wider lookup, not `$sessions` alone: a session older than the loaded
  // recents page is not a new one, and reading "New session" over a named chat
  // is the tab lying about what it holds (MJXHRM-386).
  const stored = sessionRowFor(selected)
  // A page takes the tab's NAME while it shows — the strip stays up (sessions
  // are tiles now, so it is the way back to them) and a tab reading "New
  // session" over Capabilities would name the wrong thing.
  const page = $workspacePage.get()

  registerTile({
    id: 'workspace',
    kind: 'chat',
    // "New session" only when there is genuinely no session — a draft. An id we
    // hold but cannot resolve yet is a LOADING chat, not a new one.
    title: page ?? (stored ? storedSessionTitle(stored) : selected ? translateNow('common.loading') : 'New session'),
    placement: 'main',
    chrome: {
      // The tab's lead dot — the SAME component the sidebar row, the switcher
      // and the mobile bubble strip render, so the main tab can never disagree
      // with them about a session's colour OR its status. It subscribes for
      // itself, so a turn starting no longer re-registers this tile.
      tabLead: () => <SessionStatusDot session={stored} storedSessionId={selected} />,
      linkTarget: true,
      tabWrap: wrapWorkspaceTab,
      uncloseable: true
    },
    sizing: { minWidth: '22vw' },
    onNewTab: startNewSessionTab,
    render: renderWorkspacePane
  })
}

$activeStoredSessionId.listen(syncWorkspaceTitle)
// Every source the wider lookup reads, so a tab that resolved through the
// pinned cache or the project tree retitles when the real row arrives.
SESSION_ROW_SOURCES.forEach(source => source.listen(syncWorkspaceTitle))
// No `$sessionColorById` listener: the lead dot resolves colour AND status for
// itself, so a project recolour repaints the dot without re-registering the
// tile (which invalidates the whole tree).
$workspacePage.listen(syncWorkspaceTitle)

// Typing lands in the chat you are LOOKING at. The focus bus resolves `'active'`
// through a module latch; without this it moves only when a composer is focused
// outright, so clicking a tile's transcript — or a tile simply mounting last —
// left the keys with another chat.
$focusedChatPane.listen(pane => markActiveComposer(composerTargetForPane(pane)))

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
// inside a project. The terminal is NOT workspace-gated: its zone stands on its
// own.
//
// `$effectiveCwd`, not `$currentCwd`: a detached chat falls back to the backend
// workspace root, so these surfaces have somewhere to point instead of hiding —
// which is what the terminal and statusbar have always done. That leaves the
// gate false only until the root lands, so fetch it up front rather than
// relying on the statusbar hook (its only other caller) being mounted.
void ensureWorkspaceCwd()

const $hasWorkspace = computed($effectiveCwd, cwd => Boolean(cwd.trim()))

bindPaneVisibility('files', $hasWorkspace)
// ⌘G — the review sidebar appears/disappears (and comes to the front).
bindPaneVisibility(
  'review',
  computed([$reviewOpen, $hasWorkspace], (open, workspace) => open && workspace),
  closeReview
)
// ⌃` / statusbar toggle — the terminal COLLAPSES to a rail (tab stays), not
// hides.
//
// "PTYs stay alive while collapsed" was written here as a statement of intent
// and was FALSE until MJXHRM-373. `setPaneCollapsed` sets `minimized` on the
// terminal's tree group, and the zone renderer used to render its body only
// while `!minimized` — so collapsing unmounted `TerminalView`, whose cleanup
// invokes `pty_kill`. Every ⌃` killed the shell. It is true now because the
// renderer HIDES a folded zone's body instead of unmounting it; the guarantee
// lives there, not here.
bindPaneCollapse(
  'terminal',
  $terminalOpen,
  () => setTerminalOpen(false),
  () => setTerminalOpen(true)
)

// Sessions/files Close = collapse their SIDE — but only while the pane actually
// lives in that root side column. Dragged next to main, a side collapse can't
// hide it, so Close falls back to dismissal there.
registerPaneCloser('sessions', () =>
  paneRootSide('sessions') === 'left' ? setSidebarOpen(false) : dismissTreePane('sessions')
)
registerPaneCloser('files', () =>
  paneRootSide('files') === 'right' ? $rightSidebarOpen.set(false) : dismissTreePane('files')
)

/**
 * The MAIN tab's Close.
 *
 * The workspace pane can't leave the tree, so "closing" it means EMPTYING it,
 * and what fills the hole depends on what is stacked beside it: a session tab in
 * main's own strip shifts INTO main (its tile is dropped and the session loads as
 * the primary — the session stays alive, no busy prompt); with nothing stacked,
 * main drops to a fresh "New session" draft rather than an empty void.
 *
 * Registering a closer is also what gives the tab its close GESTURE — the strip
 * reads `$panesWithCloser`, not the `uncloseable` flag, so the pane stays
 * undismissable while ⌘W / ⌘-click / middle-click / the zone menu all work on it.
 * Without this, ⌘W over a lone main tab was a dead key.
 */
registerPaneCloser(WORKSPACE_PANE_ID, () => {
  const next = nextSessionTileForWorkspace()

  if (next) {
    // Order matters — close the tile FIRST so the selection homes to the
    // workspace instead of re-fronting the tile it is being promoted out of.
    closeSessionTile(next)
    void openSession(next)

    return
  }

  // Already a blank draft? Then this IS the post-close state; leave it alone
  // rather than churning a fresh session out from under the composer.
  if ($activeStoredSessionId.get() !== null) {
    startNewSession()
  }
})

/**
 * The workspace grid: mounts the layout tree. Publishes `$workspacePage` from
 * the router location (the workspace tab reads it as its title) and fronts the
 * workspace pane whenever a full page opens in it.
 */
export function ContribController() {
  const { pathname } = useLocation()

  useEffect(() => {
    syncWorkspacePage(pathname)

    // A page opens IN the workspace pane, which with session tiles is often a
    // background tab: front it and claim its zone, or the click lands on a
    // surface nobody can see. Here rather than in the rail's handler so the
    // keybinds, the command palette and a deep link all behave the same.
    if (isWorkspacePagePath(pathname)) {
      focusWorkspaceSession()
    }
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
      {/* The backend-FS picker `selectDesktopPaths` / `selectRemotePaths` route
          to used to be mounted here. It moved to `app.tsx`: shell level was
          already too low — the sidebar and Settings both reach it, but so do the
          detached tile window, the HUD and the Android activity screen, none of
          which mount this controller. */}
    </div>
  )
}
