/**
 * MULTI-SESSION VIEW STATE — the write path and derivations over
 * `$sessionStates`, the single map that holds EVERY session: the one on screen,
 * the ones in layout-tree tiles, and the ones behind mobile bubbles.
 *
 * The map is keyed by SESSION KEY (a runtime id once the gateway has issued one,
 * a `draft:`/`hydrating:` placeholder before that — see
 * `store/session-state-types.ts`), and `$activeSessionKey` names the slice the
 * user is looking at. `store/chat.ts`'s `$messages`/`$busy`/… are computed
 * projections of that slice, so there is no second place a transcript can live
 * and no "is this event for the chat on screen?" guard to fail open (MJX-132).
 *
 * `$sessionTiles` holds the stored-session ids of open tiles (persisted — tiles
 * survive restarts); the wiring layer owns resume/submit and registers itself as
 * the delegate so tile UI stays dependency-light.
 *
 * `$workingSessionIds`/`$attentionSessionIds` live in `store/session.ts`.
 */

import { atom, computed } from 'nanostores'

import { findGroup, findGroupOfPane, type LayoutNode } from '@/components/pane-shell/tree/model'
import {
  $activeTreeGroup,
  $layoutTree,
  moveTreePane,
  noteActiveTreeGroup,
  revealTreePane
} from '@/components/pane-shell/tree/store'
import { TILE_PANE_PREFIX, WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { readJson, writeJson } from '@/lib/storage'
import { discardDeltas, disposeStreamBatch, flushDeltas } from '@/lib/stream-batch'
import { resetUnscopedStreamPin } from '@/store/event-router'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { clearAllPrompts } from '@/store/prompts'
import {
  $activeStoredSessionId,
  $unreadFinishedSessionIds,
  newSession,
  setActiveSessionStoredIdRotation
} from '@/store/session'
import {
  $activeSessionKey,
  $sessionStates,
  aliasStoredSessionId,
  clearStoredIdIndex,
  type ClientSessionState,
  dropSessionState,
  emptySessionState,
  ensureSessionSlice,
  isPlaceholderKey,
  newDraftKey,
  publishSessionState,
  rekeySession,
  runtimeKeyForStoredSession,
  setSessionDisposeHook,
  setSessionTransitionHook,
  updateSession
} from '@/store/session-state-types'
import { isSecondaryWindow } from '@/store/windows'

export { $activeSessionKey, $sessionStates }
export type { ClientSessionState }

// ---------------------------------------------------------------------------
// Stall detection (presentation hint; never mutates busy).
// ---------------------------------------------------------------------------

export const $stalledSessionIds = atom<string[]>([])

// A stable identity for "no slice", so `$activeSessionState` and the views built
// on it don't churn subscribers with a fresh object every read.
const EMPTY_SESSION_STATE: ClientSessionState = emptySessionState()

export function setSessionStalled(storedSessionId: string | null | undefined, stalled: boolean) {
  if (!storedSessionId) {
    return
  }

  const current = $stalledSessionIds.get()
  const present = current.includes(storedSessionId)

  if (stalled && !present) {
    $stalledSessionIds.set([...current, storedSessionId])
  } else if (!stalled && present) {
    $stalledSessionIds.set(current.filter(id => id !== storedSessionId))
  }
}

// --- Watchdog: marks busy sessions quiet after 8 min of stream silence -----
export const SESSION_WATCHDOG_TIMEOUT_MS = 8 * 60 * 1000
const sessionWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()

function armWatchdog(runtimeId: string) {
  const existing = sessionWatchdogTimers.get(runtimeId)

  if (existing) {
    clearTimeout(existing)
  }

  sessionWatchdogTimers.set(
    runtimeId,
    setTimeout(() => {
      sessionWatchdogTimers.delete(runtimeId)
      const current = $sessionStates.get()[runtimeId]

      if (current?.busy) {
        setSessionStalled(current.storedSessionId, true)
      }
    }, SESSION_WATCHDOG_TIMEOUT_MS)
  )
}

function clearWatchdog(runtimeId: string) {
  const t = sessionWatchdogTimers.get(runtimeId)

  if (t) {
    clearTimeout(t)
    sessionWatchdogTimers.delete(runtimeId)
  }
}

// --- Settle grace: keeps a just-finished session in the sidebar merge set ---
const SESSION_SETTLE_GRACE_MS = 30 * 1000
const settledExpiry = new Map<string, number>()

function markSettled(storedId: string) {
  settledExpiry.set(storedId, Date.now() + SESSION_SETTLE_GRACE_MS)
}

function clearSettled(storedId: string) {
  settledExpiry.delete(storedId)
}

/** Stored ids whose turn ended within the grace window. Prunes expired. */
export function getRecentlySettledSessionIds(now: number = Date.now()): string[] {
  const live: string[] = []

  for (const [id, expiry] of settledExpiry) {
    if (expiry > now) {
      live.push(id)
    } else {
      settledExpiry.delete(id)
    }
  }

  return live
}

// --- Transition detection (called automatically from publishSessionState) ---
function handleTransition(previous: ClientSessionState | null, next: ClientSessionState, key: string) {
  // Compression id rotation: signal the route-follow effect with enough
  // provenance that the consumer can reject it if the user navigated away.
  if (previous?.storedSessionId && next.storedSessionId && previous.storedSessionId !== next.storedSessionId) {
    if (key === $activeSessionKey.get()) {
      setActiveSessionStoredIdRotation({
        nextStoredSessionId: next.storedSessionId,
        previousStoredSessionId: previous.storedSessionId,
        runtimeSessionId: next.runtimeSessionId ?? key
      })
    }

    clearSettled(previous.storedSessionId)
    setSessionStalled(previous.storedSessionId, false)
  }

  if (next.busy) {
    setSessionStalled(next.storedSessionId, false)
    armWatchdog(key)
  } else {
    clearWatchdog(key)
    setSessionStalled(next.storedSessionId, false)
    setSessionStalled(previous?.storedSessionId, false)
  }

  const storedId = next.storedSessionId

  if (!storedId) {
    return
  }

  const wasWorking = previous?.busy ?? false

  if (next.busy && !wasWorking) {
    clearSettled(storedId)
  } else if (!next.busy && wasWorking) {
    markSettled(storedId)

    if (storedId !== $activeStoredSessionId.get()) {
      const cur = $unreadFinishedSessionIds.get()

      if (!cur.includes(storedId)) {
        $unreadFinishedSessionIds.set([...cur, storedId])
      }
    }
  }
}

// Plug the rich transition behaviour into the leaf's write path, and tear down
// per-session timers/prompts when a slice goes away.
setSessionTransitionHook(handleTransition)
setSessionDisposeHook((key, state) => {
  clearWatchdog(key)
  setSessionStalled(state.storedSessionId, false)
  clearAllPrompts(key)
  // Queued tokens for a slice that no longer exists would otherwise flush into
  // a freshly recreated one (`updateSession` creates on demand).
  discardDeltas(key)
})

export {
  aliasStoredSessionId,
  dropSessionState,
  ensureSessionSlice,
  isPlaceholderKey,
  newDraftKey,
  publishSessionState,
  rekeySession,
  runtimeKeyForStoredSession,
  updateSession
}

/** Drop every cached session state — used on profile switch / soft gateway-mode
 *  apply, where every runtime id is dead. */
export function clearAllSessionStates() {
  for (const timer of sessionWatchdogTimers.values()) {
    clearTimeout(timer)
  }

  sessionWatchdogTimers.clear()
  settledExpiry.clear()
  clearStoredIdIndex()
  clearAllPrompts()
  disposeStreamBatch()
  $stalledSessionIds.set([])
  $sessionStates.set({})
}

/** Point the app at a brand-new empty draft. Used after wiping the map, so the
 *  active key never dangles at a slice that no longer exists. */
export function startFreshActiveSession(): string {
  const key = newDraftKey()
  ensureSessionSlice(key)
  $activeSessionKey.set(key)
  resetUnscopedStreamPin()

  return key
}

// ---------------------------------------------------------------------------
// Slice lifecycle.
//
// Sessions accumulate: every chat opened from the sidebar leaves one behind, and
// each holds a full transcript. Desktop bounds this implicitly (its cache lives
// in a hook that unmounts); universal's map is module state, so it needs an
// explicit cap.
// ---------------------------------------------------------------------------

/** How many session slices to keep. Generous — the cost of an extra slice is
 *  memory, while evicting one the user comes back to costs a re-hydrate. */
export const MAX_CACHED_SESSIONS = 12

/** Keys that must never be evicted, whatever their age. */
function pinnedSessionKeys(): Set<string> {
  const pinned = new Set<string>([$activeSessionKey.get()])

  for (const tile of $sessionTiles.get()) {
    const key = tileRuntimeKey(tile.storedSessionId)

    if (key) {
      pinned.add(key)
    }
  }

  // Read lazily: store/chat-bubbles imports this module.
  for (const key of bubbleKeysProvider?.() ?? []) {
    pinned.add(key)
  }

  return pinned
}

let bubbleKeysProvider: (() => string[]) | null = null

/** Let the mobile bubble strip declare which sessions it is showing, so they
 *  are never evicted out from under it. */
export function setVisibleBubbleKeysProvider(provider: () => string[]): void {
  bubbleKeysProvider = provider
}

/**
 * Evict the least-recently-touched idle sessions once the map exceeds the cap.
 *
 * A session is only ever evicted when it is doing nothing the user would miss:
 * not on screen, not in a tile or bubble, not mid-turn, and not waiting on a
 * blocking prompt. So an over-cap map full of busy sessions simply stays over
 * cap — dropping a live turn to respect a cache bound would be the wrong trade.
 */
export function pruneSessionStates(): void {
  const states = $sessionStates.get()
  const keys = Object.keys(states)

  if (keys.length <= MAX_CACHED_SESSIONS) {
    return
  }

  const pinned = pinnedSessionKeys()

  const evictable = keys
    .filter(key => {
      const state = states[key]

      return !pinned.has(key) && !state.busy && !state.awaitingResponse && !state.needsInput && !isPlaceholderKey(key)
    })
    .sort((a, b) => states[a].lastTouchedAt - states[b].lastTouchedAt)

  for (const key of evictable.slice(0, keys.length - MAX_CACHED_SESSIONS)) {
    dropSessionState(key)
  }
}

// Prune whenever the map grows. A listener rather than a call at each creation
// site, so a slice created anywhere is covered; `pruning` guards the re-entry
// caused by pruneSessionStates writing the atom it is listening to.
let pruning = false
let lastSliceCount = 0

if (!isSecondaryWindow()) {
  $sessionStates.subscribe(states => {
    const count = Object.keys(states).length
    const grew = count > lastSliceCount
    lastSliceCount = count

    if (!grew || pruning) {
      return
    }

    pruning = true

    try {
      pruneSessionStates()
    } finally {
      pruning = false
    }
  })
}

/**
 * The gateway reconnected, so every runtime id it issued before is dead.
 *
 * Sessions are NOT wiped: their transcripts are still what the user was reading,
 * and a draft has no runtime binding to lose at all — clearing the map here
 * would throw away an unsent draft, which is the one thing that cannot be
 * re-fetched. Instead the live bindings are dropped so the surfaces that show a
 * session (the active chat, tiles, bubbles) re-resume it on their own.
 */
export function invalidateRuntimeBindings(): void {
  resetUnscopedStreamPin()
  flushDeltas()
  resetTileRuntimeBindings()

  for (const [key, state] of Object.entries($sessionStates.get())) {
    if (state.runtimeSessionId) {
      updateSession(key, current => ({ ...current, runtimeSessionId: null, busy: false, turnStartedAt: null }))
    }
  }
}

/** The ACTIVE session's slice — the one the user is looking at. Every session
 *  lives in the same map, so this is a plain lookup rather than the projection
 *  of a parallel set of global atoms that `$primarySessionState` used to be. */
export const $activeSessionState = computed(
  [$activeSessionKey, $sessionStates],
  (key, states) => states[key] ?? EMPTY_SESSION_STATE
)

// ---------------------------------------------------------------------------
// Session tiles.
// ---------------------------------------------------------------------------

export type SplitDir = 'bottom' | 'left' | 'right' | 'top'
export type TileDock = 'center' | SplitDir

export interface SessionTile {
  storedSessionId: string
  dir?: TileDock
  anchor?: string
  before?: null | string
  runtimeId?: string
  error?: string
}

// Tiles are persisted PER PROFILE (the live gateway is scoped to one profile at
// a time). Switching profiles swaps the visible set and drops runtime bindings.
const TILES_KEY = 'hermes.sessionTiles.v2'

type StoredTile = Pick<SessionTile, 'anchor' | 'before' | 'dir' | 'storedSessionId'>

const toStored = (t: SessionTile): StoredTile => ({
  anchor: t.anchor,
  before: t.before,
  dir: t.dir,
  storedSessionId: t.storedSessionId
})

function parseTileList(value: unknown): StoredTile[] {
  return Array.isArray(value)
    ? value
        .filter((t): t is SessionTile => Boolean(t && typeof (t as SessionTile).storedSessionId === 'string'))
        .map(t => {
          const raw = t as SessionTile

          return {
            anchor: typeof raw.anchor === 'string' ? raw.anchor : undefined,
            before: typeof raw.before === 'string' || raw.before === null ? raw.before : undefined,
            dir: raw.dir,
            storedSessionId: raw.storedSessionId
          }
        })
    : []
}

function loadTilesByProfile(): Record<string, StoredTile[]> {
  const byProfile: Record<string, StoredTile[]> = {}
  const parsed = readJson<unknown>(TILES_KEY)

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [profile, list] of Object.entries(parsed as Record<string, unknown>)) {
      const tiles = parseTileList(list)

      if (tiles.length > 0) {
        byProfile[normalizeProfileKey(profile)] = tiles
      }
    }
  }

  return byProfile
}

const tilesByProfile = loadTilesByProfile()
const profileKey = () => normalizeProfileKey($activeGatewayProfile.get())

// Runtime ids are process-scoped; the live atom hydrates from the stored
// (runtime-less) tiles for the active profile. A secondary window shows no tiles.
export const $sessionTiles = atom<SessionTile[]>(isSecondaryWindow() ? [] : [...(tilesByProfile[profileKey()] ?? [])])

function persistTiles() {
  if (isSecondaryWindow()) {
    return
  }

  writeJson(TILES_KEY, Object.keys(tilesByProfile).length === 0 ? null : tilesByProfile)
}

function saveTiles(tiles: SessionTile[]) {
  $sessionTiles.set(tiles)
  const stored = tiles.map(toStored)

  if (stored.length > 0) {
    tilesByProfile[profileKey()] = stored
  } else {
    delete tilesByProfile[profileKey()]
  }

  persistTiles()
}

// Profile switch: surface the new profile's tiles with runtime ids cleared.
// Runtime ids are issued by the gateway and scoped to one profile, so EVERY
// slice is dead — keeping them would leave sessions that can never receive
// another event, and whose ids could collide with the new profile's.
let lastProfileKey = profileKey()

if (!isSecondaryWindow()) {
  $activeGatewayProfile.subscribe(() => {
    const next = profileKey()

    if (next === lastProfileKey) {
      return
    }

    lastProfileKey = next
    $sessionTiles.set([...(tilesByProfile[next] ?? [])])
    clearAllSessionStates()
    startFreshActiveSession()
  })
}

/** The live session key behind a tile, following a compaction id rotation. */
export function tileRuntimeKey(storedSessionId: null | string): null | string {
  if (!storedSessionId) {
    return null
  }

  return (
    runtimeKeyForStoredSession(storedSessionId) ??
    $sessionTiles.get().find(t => t.storedSessionId === storedSessionId)?.runtimeId ??
    null
  )
}

export function patchSessionTile(storedSessionId: string, patch: Partial<SessionTile>) {
  saveTiles($sessionTiles.get().map(t => (t.storedSessionId === storedSessionId ? { ...t, ...patch } : t)))
}

/** Drop live runtime bindings so every tile re-resumes — used on gateway reconnect. */
export function resetTileRuntimeBindings() {
  const tiles = $sessionTiles.get()

  if (tiles.some(t => t.runtimeId)) {
    $sessionTiles.set(tiles.map(toStored))
  }
}

// ---------------------------------------------------------------------------
// Delegate — the wiring layer (owns the gateway + session cache) plugs in.
// ---------------------------------------------------------------------------

export interface SessionTileDelegate {
  archiveSession(storedSessionId: string): Promise<void>
  branchSession(storedSessionId: string): Promise<void>
  deleteSession(storedSessionId: string): Promise<void>
  executeSlash(rawCommand: string, sessionId: string): Promise<void>
  interruptSession(runtimeId: string): Promise<void>
  resumeTile(storedSessionId: string): Promise<string>
  submitToSession(runtimeId: string, text: string): Promise<void>
  updateSession(runtimeId: string, updater: (state: ClientSessionState) => ClientSessionState): ClientSessionState
}

let delegate: SessionTileDelegate | null = null

export function setSessionTileDelegate(next: SessionTileDelegate) {
  delegate = next
}

export function sessionTileDelegate(): SessionTileDelegate | null {
  return delegate
}

/** Reorder tiles to match layout-tree encounter order. Returns `null` when
 *  nothing moves so callers can skip a needless persist. */
export function orderTilesByTree<T extends { storedSessionId: string }>(
  tree: LayoutNode | null,
  tiles: readonly T[]
): null | T[] {
  if (!tree || tiles.length < 2) {
    return null
  }

  const order: string[] = []

  const walk = (node: LayoutNode) => {
    if (node.type === 'group') {
      for (const id of node.panes) {
        if (id.startsWith(TILE_PANE_PREFIX)) {
          order.push(id.slice(TILE_PANE_PREFIX.length))
        }
      }

      return
    }

    node.children.forEach(walk)
  }

  walk(tree)

  const rank = new Map(order.map((id, i) => [id, i]))

  const next = [...tiles].sort(
    (a, b) => (rank.get(a.storedSessionId) ?? Infinity) - (rank.get(b.storedSessionId) ?? Infinity)
  )

  return next.some((t, i) => t !== tiles[i]) ? next : null
}

function syncTileStripOrder() {
  const next = orderTilesByTree($layoutTree.get(), $sessionTiles.get())

  if (next) {
    saveTiles(next)
  }
}

/** Open a tile for a stored session, or MOVE an existing one to the new dock. The
 *  session LOADED IN MAIN never opens as a tile. */
export function openSessionTile(
  storedSessionId: string,
  dir: TileDock = 'right',
  anchor?: string,
  before?: null | string
) {
  const tiles = $sessionTiles.get()

  if (storedSessionId === $activeStoredSessionId.get()) {
    return
  }

  if (!tiles.some(t => t.storedSessionId === storedSessionId)) {
    saveTiles([...tiles, { anchor, before, dir, storedSessionId }])

    return
  }

  const tree = $layoutTree.get()
  const target = tree ? findGroupOfPane(tree, anchor ?? 'workspace')?.id : null

  if (target) {
    moveTreePane(`${TILE_PANE_PREFIX}${storedSessionId}`, { before: before ?? null, groupId: target, pos: dir })
    patchSessionTile(storedSessionId, { anchor, before: before ?? undefined, dir })
    syncTileStripOrder()
  }
}

/**
 * "New chat tab" — ⌘T, and the `+` at the end of a chat tab strip.
 *
 * The main pane is a pane like any other, so a new tab means: park the
 * conversation currently in it as its own tab, then start a fresh chat in the
 * main pane. Both end up in the same strip, which is what reads as two tabs.
 *
 * Order matters — `openSessionTile` refuses the session loaded in main (it
 * would then be on screen twice), so the main pane has to let go of it first.
 * An unsaved draft has nothing to park.
 */
export function newSessionTab(): void {
  const current = $activeStoredSessionId.get()

  newSession()

  if (current) {
    openSessionTile(current, 'center', WORKSPACE_PANE_ID)
  }
}

/** If a session is already ON SCREEN — an open tile OR the one loaded in main —
 *  front its tab (and focus its zone) and return true; `false` = the caller must
 *  load it into main. */
export function focusOpenSession(storedSessionId: string): boolean {
  if ($sessionTiles.get().some(t => t.storedSessionId === storedSessionId)) {
    const paneId = `${TILE_PANE_PREFIX}${storedSessionId}`
    revealTreePane(paneId)
    const tree = $layoutTree.get()
    const group = tree ? findGroupOfPane(tree, paneId) : null

    if (group) {
      noteActiveTreeGroup(group.id)
    }

    return true
  }

  if (storedSessionId === $activeStoredSessionId.get()) {
    revealTreePane('workspace')
    noteActiveTreeGroup(null)

    return true
  }

  return false
}

// Closed-tab stack for ⌘⇧T reopen (in-memory), keyed PER PROFILE.
const closedTilesByProfile: Record<string, SessionTile[]> = {}
const closedStack = (): SessionTile[] => (closedTilesByProfile[profileKey()] ??= [])

export function closeSessionTile(storedSessionId: string) {
  const tile = $sessionTiles.get().find(t => t.storedSessionId === storedSessionId)

  if (tile) {
    closedStack().push({ anchor: tile.anchor, before: tile.before, dir: tile.dir, storedSessionId })
  }

  saveTiles($sessionTiles.get().filter(t => t.storedSessionId !== storedSessionId))
}

// The tile whose close needs confirming (still working / waiting on input). The
// confirm UI (SessionTileCloseConfirm) lives in app/chat/session-tile.tsx; the
// state + trigger live here so keybinds can close a tile without importing the
// React component graph.
export const $confirmCloseTile = atom<null | string>(null)

/** Close a tile — but confirm first if its session is still working / waiting. */
export function requestCloseSessionTile(storedSessionId: string): void {
  // Resolved through the reverse index rather than the tile's cached runtimeId,
  // so a session whose stored id rotated under a background compaction is still
  // recognised as busy instead of closing without a prompt (MJX-133).
  const key = tileRuntimeKey(storedSessionId)
  const state = key ? $sessionStates.get()[key] : undefined

  if (state?.busy || state?.awaitingResponse || state?.needsInput) {
    $confirmCloseTile.set(storedSessionId)

    return
  }

  closeSessionTile(storedSessionId)
}

/** Drop a DEAD tile — a persisted tile whose session no longer exists (resume
 *  404s). Leaves no ⌘⇧T undo and evicts any cached state. */
export function discardSessionTile(storedSessionId: string) {
  const key = tileRuntimeKey(storedSessionId)

  if (key) {
    dropSessionState(key)
  }

  saveTiles($sessionTiles.get().filter(t => t.storedSessionId !== storedSessionId))
}

/** ⌘⇧T — reopen the most recently closed tab where it was. */
export function reopenLastClosedTile(): void {
  const stack = closedStack()

  for (let tile = stack.pop(); tile; tile = stack.pop()) {
    const { storedSessionId } = tile

    if (storedSessionId === $activeStoredSessionId.get()) {
      continue
    }

    if (!$sessionTiles.get().some(t => t.storedSessionId === storedSessionId)) {
      openSessionTile(storedSessionId, tile.dir, tile.anchor, tile.before)

      return
    }
  }
}

// ---------------------------------------------------------------------------
// The FOCUSED session — one derivation. The layout's interaction tracker
// ($activeTreeGroup) resolves to a zone; its active pane names the session: a
// `session-tile:<storedId>` pane IS that session, anything else falls back to the
// route-driven active session.
// ---------------------------------------------------------------------------

/** Stored id of the focused session (the interacted zone's tile, else the active one). */
export const $focusedStoredSessionId = computed(
  [$activeTreeGroup, $layoutTree, $activeStoredSessionId],
  (groupId, tree, selected) => {
    const active = groupId && tree ? findGroup(tree, groupId)?.active : undefined

    return active?.startsWith(TILE_PANE_PREFIX) ? active.slice(TILE_PANE_PREFIX.length) : selected
  }
)

/** Session key of the focused session (a tile's bound key, else the active one). */
export const $focusedRuntimeId = computed(
  [$focusedStoredSessionId, $activeStoredSessionId, $activeSessionKey, $sessionStates],
  (focused, selected, activeKey, _states) => {
    if (focused && focused !== selected) {
      return runtimeKeyForStoredSession(focused)
    }

    return activeKey
  }
)

/** The focused session's slice. One map, so this is a plain lookup — falling
 *  back to the active session when a tile has no live key yet. */
export const $focusedSessionState = computed(
  [$focusedRuntimeId, $activeSessionKey, $sessionStates],
  (key, activeKey, states) => states[key ?? activeKey] ?? states[activeKey] ?? EMPTY_SESSION_STATE
)

/** A PRIMARY navigation homes focus to the workspace — UNLESS the selected id is
 *  already an open TILE (where `focusOpenSession` owns the move). */
export const selectionHomesToWorkspace = (selected: null | string, tiles: readonly SessionTile[]): boolean =>
  !(selected && tiles.some(t => t.storedSessionId === selected))

$activeStoredSessionId.listen(selected => {
  if (!selectionHomesToWorkspace(selected, $sessionTiles.get())) {
    return
  }

  noteActiveTreeGroup(null)
  revealTreePane('workspace')
})

// Dev hook for automation.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__HERMES_SESSION_TILES__ = {
    close: closeSessionTile,
    open: openSessionTile,
    patch: patchSessionTile,
    publish: publishSessionState,
    states: () => $sessionStates.get(),
    tiles: () => $sessionTiles.get()
  }
}
