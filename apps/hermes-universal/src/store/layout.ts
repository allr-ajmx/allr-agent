import { readKey } from '@/lib/persist'
import { type Codec, Codecs, persistentAtom } from '@/lib/persisted'
import { arraysEqual, insertUniqueId } from '@/lib/storage'
import { atom, computed, type ReadableAtom, type WritableAtom } from '@/store/atom'
// TYPE-ONLY, and load-bearing that it stays that way: `store/session` imports
// this module, so a value import of either would close a runtime cycle.
import type { PullRequestBucket } from '@/store/pull-requests'
import type { SessionStatusBucket } from '@/store/session-dot-state'

import { $paneStates, ensurePaneRegistered, setPaneOpen, setPaneWidthOverride, togglePane } from './panes'

// Shell + left-sidebar layout state. Ported from desktop's `@/store/layout`,
// de-`desktop`-d to `hermes.*` storage keys. The chat-sidebar lives in the
// generic pane system (`store/panes.ts`); everything below (pins, section-open
// state, drag orders, grouping) is the sidebar's own persisted UI state.

export const SIDEBAR_DEFAULT_WIDTH = 237
export const SIDEBAR_MAX_WIDTH = 360
export const SIDEBAR_SESSIONS_PAGE_SIZE = 50

export const CHAT_SIDEBAR_PANE_ID = 'chat-sidebar'

ensurePaneRegistered(CHAT_SIDEBAR_PANE_ID, { open: true })

export const $sidebarOpen: ReadableAtom<boolean> = computed(
  $paneStates,
  states => states[CHAT_SIDEBAR_PANE_ID]?.open ?? true
)

export const $sidebarWidth: ReadableAtom<number> = computed($paneStates, states => {
  const override = states[CHAT_SIDEBAR_PANE_ID]?.widthOverride

  return typeof override === 'number' ? override : SIDEBAR_DEFAULT_WIDTH
})

// `panesFlipped` mirrors the sidebar to the right edge (parity with desktop's
// left/right swap). The titlebar swap button drives it; the shell reads it to
// pick the pane `side`.
export const $panesFlipped = persistentAtom<boolean>('hermes.panesFlipped', false, Codecs.bool)

export function togglePanesFlipped(): void {
  $panesFlipped.set(!$panesFlipped.get())
}

// Right sidebar = the file-tree + file viewer/editor panes (ported from desktop).
// The titlebar's right-sidebar toggle drives this group gate.
export const $rightSidebarOpen = persistentAtom<boolean>('hermes.rightSidebarOpen', false, Codecs.bool)

export function toggleRightSidebar(): void {
  $rightSidebarOpen.set(!$rightSidebarOpen.get())
}

// POSITIONAL toggles (desktop parity — see desktop's `titlebar-controls.tsx`):
// each titlebar button / keybind shows-hides everything on its PHYSICAL side of
// main, so it stays truthful through a swap. Unflipped: left ≙ chat sidebar,
// right ≙ the file/editor/terminal rails; flipped, the two trade places.
export const $leftEdgeOpen: ReadableAtom<boolean> = computed(
  [$panesFlipped, $sidebarOpen, $rightSidebarOpen],
  (flipped, sidebarOpen, rightOpen) => (flipped ? rightOpen : sidebarOpen)
)

export const $rightEdgeOpen: ReadableAtom<boolean> = computed(
  [$panesFlipped, $sidebarOpen, $rightSidebarOpen],
  (flipped, sidebarOpen, rightOpen) => (flipped ? sidebarOpen : rightOpen)
)

export function toggleLeftEdge(): void {
  if ($panesFlipped.get()) {
    toggleRightSidebar()
  } else {
    toggleSidebarOpen()
  }
}

export function toggleRightEdge(): void {
  if ($panesFlipped.get()) {
    toggleSidebarOpen()
  } else {
    toggleRightSidebar()
  }
}

// ── Right pane geometry + terminal ──────────────────────────────────────────
export const FILE_TREE_PANE_ID = 'file-tree'
export const PREVIEW_PANE_ID = 'preview'
export const TERMINAL_PANE_ID = 'terminal'

export const FILE_TREE_DEFAULT_WIDTH = 260
export const FILE_TREE_MIN_WIDTH = 180
export const FILE_TREE_MAX_WIDTH = 420
export const PREVIEW_DEFAULT_WIDTH = 440
export const PREVIEW_MIN_WIDTH = 300
export const PREVIEW_MAX_WIDTH = 760
export const TERMINAL_DEFAULT_HEIGHT = 260
export const TERMINAL_MIN_HEIGHT = 120
export const TERMINAL_MAX_HEIGHT = 640
// When both the file tree + editor are closed, the terminal becomes a full-height
// right column of this (independently resizable) preset width.
export const TERMINAL_COLUMN_PANE_ID = 'terminal-column'
export const TERMINAL_COLUMN_DEFAULT_WIDTH = 480
export const TERMINAL_COLUMN_MIN_WIDTH = 300
export const TERMINAL_COLUMN_MAX_WIDTH = 900

ensurePaneRegistered(FILE_TREE_PANE_ID, { open: true })
ensurePaneRegistered(PREVIEW_PANE_ID, { open: true })
ensurePaneRegistered(TERMINAL_PANE_ID, { open: true })
ensurePaneRegistered(TERMINAL_COLUMN_PANE_ID, { open: true })

// The integrated terminal is a full-width bottom dock, toggled fully
// independently of the file/editor right sidebar (parity with desktop's separate
// terminal takeover). It stays visible even when the right sidebar is closed.
export const $terminalOpen = persistentAtom<boolean>('hermes.terminalOpen', false, Codecs.bool)

export function toggleTerminalOpen(): void {
  $terminalOpen.set(!$terminalOpen.get())
}

export function setTerminalOpen(open: boolean): void {
  $terminalOpen.set(open)
}

// A request to reveal (expand ancestors + select) a path in the file tree. The
// tree pane subscribes, drives arborist to the node, then resets to null.
export const $revealInTreeRequest = atom<string | null>(null)

export function revealFileInTree(path: string): void {
  $rightSidebarOpen.set(true)
  $revealInTreeRequest.set(path)
}

// ── Pinned sessions ─────────────────────────────────────────────────────────
export const $pinnedSessionIds = persistentAtom('hermes.pinnedSessions', [] as string[], Codecs.stringArray)

// ── Session / project / workspace drag orders ───────────────────────────────
export const $sidebarSessionOrderIds = persistentAtom('hermes.sessionOrder', [] as string[], Codecs.stringArray)
export const $sidebarSessionOrderManual = persistentAtom('hermes.sessionOrder.manual', false, Codecs.bool)
export const $sidebarWorkspaceOrderIds = persistentAtom('hermes.workspaceOrder', [] as string[], Codecs.stringArray)
// Order of the top-level repo "parent" groups in the worktree tree (worktrees
// within a parent reuse $sidebarWorkspaceOrderIds).
export const $sidebarWorkspaceParentOrderIds = persistentAtom(
  'hermes.workspaceParentOrder',
  [] as string[],
  Codecs.stringArray
)
// Manual drag-order of projects in the overview. Empty = the deterministic
// default sort; once the user drags a project their order wins.
export const $sidebarProjectOrderIds = persistentAtom('hermes.projectOrder', [] as string[], Codecs.stringArray)
// Persisted open/collapse for repo/worktree (and review file-tree) nodes, as the
// RESOLVED boolean per node rather than a set of collapsed ids. That distinction
// is load-bearing for worktree lanes: an empty lane defaults COLLAPSED and the
// same lane defaults OPEN once it holds a session, so a "collapsed ids" set
// silently reinterprets the user's explicit choice the moment the default flips.
// An absent id follows the caller's `defaultOpen`. Desktop parity.
const WORKSPACE_NODE_OPEN_KEY = 'hermes.workspaceNodeOpen'
const LEGACY_WORKSPACE_COLLAPSED_KEY = 'hermes.workspaceCollapsed'

// One-time migration off the old XOR `workspaceCollapsed` string[]: every id in
// it was explicitly collapsed, which is exactly `false` in the new model.
function migrateWorkspaceCollapsedIds(): Record<string, boolean> {
  const raw = readKey(LEGACY_WORKSPACE_COLLAPSED_KEY)

  if (!raw) {
    return {}
  }

  try {
    const legacy: unknown = JSON.parse(raw)

    return Array.isArray(legacy)
      ? Object.fromEntries(legacy.filter((id): id is string => typeof id === 'string').map(id => [id, false]))
      : {}
  } catch {
    return {}
  }
}

export const $sidebarWorkspaceNodeOpen = persistentAtom<Record<string, boolean>>(
  WORKSPACE_NODE_OPEN_KEY,
  migrateWorkspaceCollapsedIds(),
  Codecs.json<Record<string, boolean>>(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    )
  })
)
// Auto-derived (git-repo) projects dismissed from the overview (keyed by repo root).
export const $dismissedAutoProjectIds = persistentAtom(
  'hermes.dismissedAutoProjects',
  [] as string[],
  Codecs.stringArray
)
// Worktree rows hidden after a `git worktree remove` (keyed by worktree path).
export const $dismissedWorktreeIds = persistentAtom('hermes.dismissedWorktrees', [] as string[], Codecs.stringArray)

// ── Section open state ──────────────────────────────────────────────────────
export const $sidebarPinsOpen = atom(true)
export const $sidebarRecentsOpen = atom(true)
// Cron section collapsed by default (only renders when cron jobs exist).
export const $sidebarCronOpen = persistentAtom('hermes.sidebarCronOpen', false, Codecs.bool)
// Messaging platform sections collapse by default; we persist ids the user has
// explicitly expanded, so the default stays collapsed.
export const $sidebarMessagingOpenIds = persistentAtom(
  'hermes.sidebarMessagingOpen',
  [] as string[],
  Codecs.stringArray
)
export const $sidebarAgentsGrouped = persistentAtom('hermes.agentsGroupedByWorkspace', false, Codecs.bool)

// ── Sidebar view: grouping, ordering, row metadata, filters ─────────────────
//
// Ported from desktop `store/layout.ts` (the state behind `sidebar/filter-menu`),
// adapted where universal's list model genuinely differs — see each note.

/**
 * How the recents list is divided.
 *
 * DIVERGES FROM DESKTOP, deliberately. Desktop offers `date | project | status`,
 * where `date` and `status` are DIVIDER rows interleaved with sessions
 * (`lib/session-date-groups.ts` → `SidebarListRow`). Universal has no divider
 * row model at all: `sessions-section` renders a flat `SessionInfo[]` and its
 * virtualizer is indexed by session, not by row. Offering `date`/`status` here
 * would ship two radio options that change nothing, so the two views universal
 * actually HAS are the two it offers.
 */
export type SidebarGrouping = 'project' | 'sessions'

/** What ranks rows within whatever grouping is active. */
export type SidebarOrdering = 'cost' | 'created' | 'manual' | 'status' | 'tokens' | 'updated'

/** The sort keys the menu offers; `manual` is entered by dragging, not picked. */
export type SidebarSortKey = Exclude<SidebarOrdering, 'manual'>

/**
 * Optional per-row metadata the user can switch on.
 *
 * DIVERGES FROM DESKTOP: desktop also has `pr` and `profile` here. Universal's
 * row already renders both unconditionally by their own rules (the PR chip
 * whenever the branch join finds one, the profile chip in the all-profiles
 * browse scope), so a toggle for either could only TAKE AWAY an affordance that
 * ships today — a regression wearing an option's clothes. This set is purely
 * additive: it pins the age that is otherwise hover-only, and adds the two
 * chips the row has never shown.
 */
export type SidebarRowMeta = 'cost' | 'tokens' | 'updated'

/** One-of-N persisted enum: an unknown stored value falls back rather than
 *  poisoning the view with a state no code handles. */
function oneOf<T extends string>(values: readonly T[], fallback: T): Codec<T> {
  return {
    decode: raw => (values.includes(raw as T) ? (raw as T) : fallback),
    encode: value => value
  }
}

/** Persisted subset of a known enum — same reasoning, per element. */
function listOf<T extends string>(values: readonly T[]): Codec<T[]> {
  return {
    decode: raw => Codecs.stringArray.decode(raw).filter((item): item is T => values.includes(item as T)),
    encode: value => Codecs.stringArray.encode(value)
  }
}

const ROW_META: readonly SidebarRowMeta[] = ['cost', 'tokens', 'updated']
const STATUS_FILTERS: readonly SessionStatusBucket[] = ['needs-input', 'working', 'unread', 'idle']
const PR_FILTERS: readonly PullRequestBucket[] = ['open', 'draft', 'merged', 'closed', 'none']
export const SIDEBAR_SORT_KEYS: readonly SidebarSortKey[] = ['updated', 'created', 'status', 'tokens', 'cost']

/**
 * The grouping, as one value.
 *
 * Not its own persisted atom: `$sidebarAgentsGrouped` above is already the
 * single authority for the project view — the header toggle, ⌘K's "enter
 * project" and the repo scan all write it — and a second stored copy is how the
 * menu and the header end up disagreeing about which view is on.
 */
export const $sidebarGrouping: ReadableAtom<SidebarGrouping> = computed($sidebarAgentsGrouped, grouped =>
  grouped ? 'project' : 'sessions'
)

const $sidebarSortKey = persistentAtom<SidebarSortKey>(
  'hermes.sidebarSortKey',
  'updated',
  oneOf(SIDEBAR_SORT_KEYS, 'updated')
)

// A hand-dragged order outranks any sort key — dragging IS how you pick manual,
// so the menu reflects that rather than offering a fourth way to say it.
export const $sidebarOrdering: ReadableAtom<SidebarOrdering> = computed(
  [$sidebarSessionOrderManual, $sidebarSortKey],
  (manual, key) => (manual ? 'manual' : key)
)

export const $sidebarRowMeta = persistentAtom<SidebarRowMeta[]>('hermes.sidebarRowMeta', [], listOf(ROW_META))

export const $sidebarStatusFilter = persistentAtom<SessionStatusBucket[]>(
  'hermes.sidebarStatusFilter',
  [],
  listOf(STATUS_FILTERS)
)

// Project ids as `liveSessionProjectId` reports them: an explicit project's id,
// or a repo root path for an auto-promoted one.
export const $sidebarProjectFilter = persistentAtom('hermes.sidebarProjectFilter', [] as string[], Codecs.stringArray)

// Whether a session's branch has a PR, and in what state. Fetched per repo via
// the gateway's `gh` (see store/pull-requests), so this is empty on a backend
// where `gh` is missing or unauthenticated — every row reads `none` and the
// filter still behaves, it just has one bucket to sort into.
export const $sidebarPrFilter = persistentAtom<PullRequestBucket[]>('hermes.sidebarPrFilter', [], listOf(PR_FILTERS))

// Archived sessions are a separate backend query (`archived: 'only'`), so this
// flag both filters the list and drives the fetch.
export const $sidebarShowArchived = persistentAtom('hermes.sidebarShowArchived', false, Codecs.bool)

/** Anything that HIDES rows — what makes the menu's trigger read as engaged. */
export const $sidebarFiltersActive: ReadableAtom<boolean> = computed(
  [$sidebarStatusFilter, $sidebarProjectFilter, $sidebarPrFilter, $sidebarShowArchived],
  (statuses, projects, prs, archived) => statuses.length > 0 || projects.length > 0 || prs.length > 0 || archived
)

/** Anything at all moved off the shipped view — what makes a reset worth
 *  offering. Broader than {@link $sidebarFiltersActive}, which only knows about
 *  what hides rows, not about how they're grouped, sorted or labelled. */
export const $sidebarViewCustomized: ReadableAtom<boolean> = computed(
  [$sidebarGrouping, $sidebarOrdering, $sidebarRowMeta, $sidebarFiltersActive],
  (grouping, ordering, rowMeta, filtersActive) =>
    grouping !== 'sessions' || ordering !== 'updated' || rowMeta.length > 0 || filtersActive
)

function toggleIn<T extends string>($atom: WritableAtom<T[]>, value: T) {
  const current = $atom.get()

  $atom.set(current.includes(value) ? current.filter(item => item !== value) : [...current, value])
}

export function toggleSidebarRowMeta(meta: SidebarRowMeta) {
  toggleIn($sidebarRowMeta, meta)
}

export function toggleSidebarStatusFilter(status: SessionStatusBucket) {
  toggleIn($sidebarStatusFilter, status)
}

export function toggleSidebarProjectFilter(projectId: string) {
  toggleIn($sidebarProjectFilter, projectId)
}

export function toggleSidebarPrFilter(bucket: PullRequestBucket) {
  toggleIn($sidebarPrFilter, bucket)
}

export function setSidebarShowArchived(show: boolean) {
  if ($sidebarShowArchived.get() !== show) {
    $sidebarShowArchived.set(show)
  }
}

export function setSidebarOrdering(ordering: SidebarOrdering) {
  if (ordering === 'manual') {
    setSidebarSessionOrderManual(true)

    return
  }

  // Picking a sort key is the only way back out of a hand-dragged order, so it
  // has to drop the saved sequence as well as the flag.
  setSidebarSessionOrderManual(false)
  setSidebarSessionOrderIds([])
  $sidebarSortKey.set(ordering)
}

function clearSidebarFilters() {
  $sidebarStatusFilter.set([])
  $sidebarProjectFilter.set([])
  $sidebarPrFilter.set([])
  setSidebarShowArchived(false)
}

/**
 * Every knob the filter menu owns, back to the sidebar as it ships.
 *
 * Grouping is NOT reset here — see `setSidebarGrouping` in `store/projects.ts`,
 * which has to leave the entered project scope on the way out and cannot be
 * called from this module without a cycle. `resetSidebarView` is composed with
 * it at the one call site that needs both.
 */
export function resetSidebarView() {
  setSidebarOrdering('updated')
  $sidebarRowMeta.set([])
  clearSidebarFilters()
}

// Fold a whole level shut (or open) in one write — the menu's "Collapse all"
// over the project rows. Their lanes keep their own state underneath, so
// re-opening a project shows it as the user left it.
export function setWorkspaceNodesOpen(ids: readonly string[], open: boolean): void {
  if (!ids.length) {
    return
  }

  $sidebarWorkspaceNodeOpen.set({
    ...$sidebarWorkspaceNodeOpen.get(),
    ...Object.fromEntries(ids.map(id => [id, open]))
  })
}

// Set by the PaneShell hover-reveal overlay while the sidebar is collapsed; kept
// true the whole time it's a floating overlay so ChatSidebar mounts its rows
// off-screen, ready to slide.
export const $sidebarOverlayMounted = atom(false)
export const $isSidebarResizing = atom(false)
export const $sessionsLimit = atom(SIDEBAR_SESSIONS_PAGE_SIZE)

// ── Pane open/width helpers ─────────────────────────────────────────────────
export function setSidebarWidth(width: number) {
  const bounded = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_DEFAULT_WIDTH, width))
  setPaneWidthOverride(CHAT_SIDEBAR_PANE_ID, bounded)
}

export function setSidebarOpen(open: boolean) {
  setPaneOpen(CHAT_SIDEBAR_PANE_ID, open)
}

export function toggleSidebarOpen() {
  togglePane(CHAT_SIDEBAR_PANE_ID)
}

// ── Workspace node collapse / project dismissal ─────────────────────────────
export function workspaceNodeOpen(id: string, defaultOpen = true): boolean {
  return $sidebarWorkspaceNodeOpen.get()[id] ?? defaultOpen
}

// Force a node open/collapsed. Stable across a default flip — used by "+ new
// session" to reveal the lane it targets and keep it open once it's populated.
export function setWorkspaceNodeOpen(id: string, open: boolean): void {
  const current = $sidebarWorkspaceNodeOpen.get()

  if (current[id] === open) {
    return
  }

  $sidebarWorkspaceNodeOpen.set({ ...current, [id]: open })
}

// Toggle a repo/worktree/file-tree node relative to its current resolved state.
export function toggleWorkspaceNodeCollapsed(id: string, defaultOpen = true): void {
  setWorkspaceNodeOpen(id, !workspaceNodeOpen(id, defaultOpen))
}

export function dismissAutoProject(id: string): void {
  const current = $dismissedAutoProjectIds.get()

  if (!current.includes(id)) {
    $dismissedAutoProjectIds.set([...current, id])
  }
}

export function dismissWorktree(id: string): void {
  const current = $dismissedWorktreeIds.get()

  if (!current.includes(id)) {
    $dismissedWorktreeIds.set([...current, id])
  }
}

export function restoreWorktree(id: string): void {
  const current = $dismissedWorktreeIds.get()

  if (current.includes(id)) {
    $dismissedWorktreeIds.set(current.filter(worktreeId => worktreeId !== id))
  }
}

// ── Hotkey → focus the sessions search field ────────────────────────────────
// Opens the sidebar first, then lets the field (which only mounts when the
// sidebar is open) subscribe + focus.
export const SESSION_SEARCH_FOCUS_EVENT = 'hermes:focus-session-search'

// Flash the ⌘N hint on the New-session rail row when the shortcut fires.
export const NEW_SESSION_FLASH_EVENT = 'hermes:new-session-flash'

export function requestSessionSearchFocus() {
  setSidebarOpen(true)

  if (typeof window !== 'undefined') {
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(SESSION_SEARCH_FOCUS_EVENT)), 0)
  }
}

// ── Section toggles ─────────────────────────────────────────────────────────
export function setSidebarPinsOpen(open: boolean) {
  $sidebarPinsOpen.set(open)
}

export function setSidebarOverlayMounted(mounted: boolean) {
  $sidebarOverlayMounted.set(mounted)
}

export function setSidebarRecentsOpen(open: boolean) {
  $sidebarRecentsOpen.set(open)
}

export function setSidebarCronOpen(open: boolean) {
  $sidebarCronOpen.set(open)
}

export function toggleSidebarMessagingOpen(sourceId: string) {
  const current = $sidebarMessagingOpenIds.get()

  $sidebarMessagingOpenIds.set(
    current.includes(sourceId) ? current.filter(id => id !== sourceId) : [...current, sourceId]
  )
}

export function setSidebarAgentsGrouped(grouped: boolean) {
  $sidebarAgentsGrouped.set(grouped)
}

// ── Order setters (skip write when unchanged) ───────────────────────────────
export function setSidebarSessionOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarSessionOrderIds.get(), ids)) {
    $sidebarSessionOrderIds.set(ids)
  }
}

export function setSidebarSessionOrderManual(manual: boolean) {
  if ($sidebarSessionOrderManual.get() !== manual) {
    $sidebarSessionOrderManual.set(manual)
  }
}

export function setSidebarWorkspaceOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarWorkspaceOrderIds.get(), ids)) {
    $sidebarWorkspaceOrderIds.set(ids)
  }
}

export function setSidebarWorkspaceParentOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarWorkspaceParentOrderIds.get(), ids)) {
    $sidebarWorkspaceParentOrderIds.set(ids)
  }
}

export function setSidebarProjectOrderIds(ids: string[]) {
  if (!arraysEqual($sidebarProjectOrderIds.get(), ids)) {
    $sidebarProjectOrderIds.set(ids)
  }
}

export function setSidebarResizing(resizing: boolean) {
  $isSidebarResizing.set(resizing)
}

// ── Pin mutations ───────────────────────────────────────────────────────────
export function pinSession(sessionId: string, index?: number) {
  const prev = $pinnedSessionIds.get()
  const next = insertUniqueId(prev, sessionId, index ?? prev.filter(id => id !== sessionId).length)

  if (!arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

export function unpinSession(sessionId: string) {
  const prev = $pinnedSessionIds.get()
  const next = prev.filter(id => id !== sessionId)

  if (!arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

// Replace the whole pinned order at once (drag-reorder hands back the new order).
// Keep only ids that are actually pinned so a stale row can't smuggle an
// unpinned id into the store.
export function setPinnedSessionOrder(ids: string[]) {
  const prev = $pinnedSessionIds.get()
  const pinned = new Set(prev)
  const next = ids.filter(id => pinned.has(id))

  if (next.length === prev.length && !arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

export function bumpSessionsLimit(step: number = SIDEBAR_SESSIONS_PAGE_SIZE) {
  const safeStep = Math.max(1, Math.floor(step))
  $sessionsLimit.set($sessionsLimit.get() + safeStep)
}

export function resetSessionsLimit() {
  if ($sessionsLimit.get() !== SIDEBAR_SESSIONS_PAGE_SIZE) {
    $sessionsLimit.set(SIDEBAR_SESSIONS_PAGE_SIZE)
  }
}
