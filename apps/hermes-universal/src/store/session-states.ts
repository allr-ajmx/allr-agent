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
  renameTreePane,
  revealTreePane
} from '@/components/pane-shell/tree/store'
import {
  DRAFT_TILE_KEY,
  DRAFT_TILE_PANE_ID,
  storedIdFromTilePane,
  TILE_PANE_PREFIX,
  WORKSPACE_PANE_ID
} from '@/lib/pane-ids'
import { readJson, writeJson } from '@/lib/storage'
import { discardDeltas, disposeStreamBatch, flushDeltas } from '@/lib/stream-batch'
import { beginDetached, endSpan } from '@/observability'
import { requestClose } from '@/store/close-confirm'
import { clearAllCompaction } from '@/store/compaction'
import { resetUnscopedStreamPin } from '@/store/event-router'
import { clearLiveSessionStatuses } from '@/store/live-session-registry'
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
import { clearAllTurns } from '@/store/turn-lifecycle'
import { isSecondaryWindow, ownsPersistedAppState } from '@/store/windows'

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

    setSessionStalled(previous.storedSessionId, false)
  }

  // A DRAFT taking its issued id — the guard above misses it, because a draft
  // has no previous stored id to differ from. This is the one moment the app's
  // one unsaved chat becomes a real one, so both surfaces that gave it a
  // placeholder identity trade it in here: the desktop tile is renamed in place,
  // and the mobile bubble folds the id in (chat-bubbles.ts, via its own
  // `$activeStoredSessionId` watcher).
  if (!previous?.storedSessionId && next.storedSessionId) {
    adoptDraftTile(next.storedSessionId)
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

  // The busy→idle EDGE is what marks a background session unread ("your turn").
  if (!next.busy && (previous?.busy ?? false) && storedId !== $activeStoredSessionId.get()) {
    const cur = $unreadFinishedSessionIds.get()

    if (!cur.includes(storedId)) {
      $unreadFinishedSessionIds.set([...cur, storedId])
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
  clearStoredIdIndex()
  clearAllPrompts()
  // Liveness is scoped to the gateway that reported it: both callers are moving
  // to a backend whose registry we have not read yet, so every row it named is
  // as dead as the runtime ids above.
  clearLiveSessionStatuses()
  // Turns are keyed by the SAME session keys this wipes, and the map is not
  // reachable through `dropSessionState` from here — the whole atom is replaced
  // below rather than evicted key by key. Both callers (a profile switch, the
  // soft gateway switch) are moving to a backend that never issued these runtime
  // ids, so every record left behind is a turn nothing can settle, reconcile or
  // find a slice for. `clearAllTurns` and not a per-key drop, deliberately: a
  // drop settles the record, and `store/turn-hydration.ts` clears the crash
  // journal on settle — a switch must not destroy the journal a later switch
  // back would recover from.
  clearAllTurns()
  // The THIRD module keyed by session key, and the one this wipe forgot.
  // `clearAllCompaction` was written for exactly this ("profile switch, gateway
  // teardown") and had no caller at all — a compaction live at the moment of the
  // switch was left in `$compactingSessions` under a runtime id the new backend
  // will never issue, so nothing could ever clear it: the settle observer only
  // fires for turns, and `clearAllTurns` above replaces the atom wholesale
  // without emitting one. That is a permanently-set steer gate for any key that
  // came back, and a leak for every one that didn't (MJXHRM-357).
  clearAllCompaction()
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

if (ownsPersistedAppState()) {
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
 * The gateway reconnected: every turn we thought was live is now unverified, and
 * the tile bindings and stream pin that named the previous socket's runs are
 * dead.
 *
 * Sessions are NOT wiped: their transcripts are still what the user was reading,
 * and a draft has no runtime binding to lose at all — clearing the map here
 * would throw away an unsent draft, which is the one thing that cannot be
 * re-fetched.
 *
 * The slice's `runtimeSessionId` is NOT cleared either, and that is the whole
 * correction (MJXHRM-358). It used to be, on the reasoning that a reconnect
 * re-issues runtime ids — but nothing ever put it back. A soft reconnect
 * re-claims the SAME live record (`_claim_or_reuse_live`), so the id is usually
 * still valid; when it genuinely is dead, `store/session-recovery.ts` rebinds it
 * on the first verb that uses it, which is exactly what that resolver exists for
 * and what tiles have always relied on. Nulling it instead made a persisted
 * conversation indistinguishable from a DRAFT for the rest of the process:
 * `ensureSession` saw no session id and answered the first message after any
 * reconnect with `session.create`, forking the chat into a brand-new empty
 * session under the old transcript. Handoff, `/branch`, the model picker, the
 * context-usage read and the compaction id-rotation guard all read the same
 * atom and went dead with it.
 *
 * What IS cleared is the liveness: `busy` and `turnStartedAt` describe a turn on
 * a socket that no longer exists. `store/turn-lifecycle.ts#reconcileInflightTurns`
 * re-arms them for a turn the gateway is still running, and `session.active_list`
 * (store/live-session-status.ts) covers the sessions that had no local record.
 */
export function invalidateRuntimeBindings(): void {
  resetUnscopedStreamPin()
  flushDeltas()
  resetTileRuntimeBindings()

  for (const [key, state] of Object.entries($sessionStates.get())) {
    if (state.busy || state.turnStartedAt !== null) {
      updateSession(key, current => ({ ...current, busy: false, turnStartedAt: null }))
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
  if (!ownsPersistedAppState()) {
    return
  }

  writeJson(TILES_KEY, Object.keys(tilesByProfile).length === 0 ? null : tilesByProfile)
}

function saveTiles(tiles: SessionTile[]) {
  $sessionTiles.set(tiles)
  // The draft tile is never persisted: `draft` names no session, so restoring it
  // would reopen an empty tab pointing at nothing. Same rule the bubble row
  // already applies to its draft.
  const stored = tiles.filter(t => t.storedSessionId !== DRAFT_TILE_KEY).map(toStored)

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

if (ownsPersistedAppState()) {
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

  // The draft tile names no session, so there is no stored id to look up — its
  // slice is the active placeholder one. Resolving it HERE rather than in the
  // pane is what makes the draft a tile like any other: its view, its busy
  // state and its close-confirm all read through this one function.
  if (storedSessionId === DRAFT_TILE_KEY) {
    const active = $activeSessionKey.get()

    return isPlaceholderKey(active) ? active : null
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

/**
 * Open spans for chats currently being opened, keyed by stored-session id.
 *
 * "Opening a chat is slow" is a user-facing claim and nothing in the trace
 * measured it: the store write is one frame, the adoption another, the mount a
 * third, and no span covered the whole arc. This one runs from the gesture to
 * the first paint that shows the chat — see `noteSessionTileMounted`.
 *
 * Detached, not stacked: it spans several tasks, and a stack-pushed span held
 * that long would sweep everything opened in the meantime underneath it.
 */
const opening = new Map<string, number>()

/**
 * Close the `chat.open` span for a tile that has just mounted.
 *
 * Called from `SessionTilePane`'s mount effect and closed on the NEXT frame
 * rather than immediately: at effect time React has committed the DOM but the
 * frame has not painted, and click-to-commit is a different (and much more
 * flattering) number than click-to-pixels.
 */
export function noteSessionTileMounted(storedSessionId: string): void {
  const id = opening.get(storedSessionId)

  if (id === undefined) {
    return
  }

  opening.delete(storedSessionId)
  requestAnimationFrame(() => endSpan(id))
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
    // No session id in the attributes — these spans end up in shared traces.
    opening.set(storedSessionId, beginDetached('chat.open', { dir }))
    saveTiles([...tiles, { anchor, before, dir, storedSessionId }])

    return
  }

  const tree = $layoutTree.get()
  const target = tree ? findGroupOfPane(tree, anchor ?? WORKSPACE_PANE_ID)?.id : null

  if (target) {
    moveTreePane(`${TILE_PANE_PREFIX}${storedSessionId}`, { before: before ?? null, groupId: target, pos: dir })
    patchSessionTile(storedSessionId, { anchor, before: before ?? undefined, dir })
    syncTileStripOrder()
  }
}

/**
 * Where a BRANCH lands: its own tab in the strip its PARENT is in, fronted.
 *
 * Both halves are load-bearing, and neither came for free:
 *
 *  - the ANCHOR. `openSessionTile` with none docks against the workspace, so a
 *    branch of a chat that is itself a tile in a side zone appeared in the main
 *    strip — a tab in a zone the user was not looking at. `newSessionTab`
 *    already anchors ⌘T "in the strip you asked from"; a branch is the same act
 *    with a seeded transcript.
 *  - the FOCUS. Registering a tile only CONTRIBUTES a pane, and adoption is
 *    deliberately silent (`insertAtGroup(..., activate: false)` — a tool panel
 *    must not steal its zone's tab on boot), so the branch was stacked into the
 *    strip BEHIND the chat it came from and nothing on screen changed. That is
 *    the "never foregrounds the new tab" this ticket is named for, and it
 *    outlived PR #125, which only stopped the branch claiming the main pane.
 *    `focusOpenSession` is the explicit reveal every other on-screen jump uses.
 */
export function openBranchTile(branchStoredId: string, parentStoredId: null | string): void {
  const anchor =
    parentStoredId && $sessionTiles.get().some(t => t.storedSessionId === parentStoredId)
      ? `${TILE_PANE_PREFIX}${parentStoredId}`
      : WORKSPACE_PANE_ID

  openSessionTile(branchStoredId, 'center', anchor)
  focusOpenSession(branchStoredId)
}

/**
 * "New chat tab" — ⌘T, and the `+` at the end of a chat tab strip.
 *
 * The new chat gets its OWN tile, beside whatever is already open. It used to
 * work the other way around: the draft took over the main pane and the chat that
 * was already there got parked into a tile — so asking for a new chat moved a
 * chat you had not asked about, and the new one was the single chat in the app
 * that was not a tile. A draft is a session like any other in `$sessionStates`;
 * this makes it a tile like any other too.
 *
 * ONE draft at a time: a second `+` on an empty draft fronts the one already
 * there rather than stacking up empty chats nobody sent a message in.
 *
 * `cwd` anchors the draft, so ⌘T can honour the sidebar's project scope the same
 * way ⌘N does (MJXHRM-393). Omitted, the draft falls back to the configured
 * default project dir inside `resetChat`, exactly as before.
 */
export function newSessionTab(cwd?: string): void {
  newSession(cwd)

  // Anchored on the chat the user is looking at, stacked into its zone — a new
  // tab belongs in the strip you asked from, not docked to the side.
  const anchor = activeChatPaneId()

  if (!$sessionTiles.get().some(t => t.storedSessionId === DRAFT_TILE_KEY)) {
    saveTiles([...$sessionTiles.get(), { anchor, dir: 'center', storedSessionId: DRAFT_TILE_KEY }])
  }

  focusDraftTile(anchor)
}

/**
 * Front the draft tile and claim the zone it lives in.
 *
 * The zone is resolved from the ANCHOR, not from the draft's own pane: the tile
 * was registered a moment ago and the pane mirror does not put it in the tree
 * until React's next commit, so looking the draft up here finds nothing and the
 * focused zone stays `null` — which is exactly the state that leaves ⌥1-9 and
 * ⌃Tab inert (they read `$activeTreeGroup` raw). The draft stacks INTO the
 * anchor's zone, so the anchor names the right group and it is already there.
 */
function focusDraftTile(anchor: string): void {
  revealTreePane(DRAFT_TILE_PANE_ID)

  const tree = $layoutTree.get()

  if (!tree) {
    return
  }

  const group = findGroupOfPane(tree, DRAFT_TILE_PANE_ID) ?? findGroupOfPane(tree, anchor)

  if (group) {
    noteActiveTreeGroup(group.id)
  }
}

/** The pane of the chat currently on screen — a tile's if one is fronted, else
 *  the workspace. What a new tab anchors to. */
function activeChatPaneId(): string {
  const active = $activeStoredSessionId.get()
  const tile = active && $sessionTiles.get().some(t => t.storedSessionId === active)

  return tile ? `${TILE_PANE_PREFIX}${active}` : WORKSPACE_PANE_ID
}

/**
 * The draft tile taking its real session id, on first submit.
 *
 * A rename, not a close-and-reopen: re-registering would send the pane back
 * through adoption and dock it wherever its hint points, so the chat would jump
 * zones at the exact moment the user hit send. `renameTreePane` carries the slot,
 * the width and the active flag; this carries the tile record.
 */
function adoptDraftTile(storedSessionId: string): void {
  const tiles = $sessionTiles.get()

  if (!tiles.some(t => t.storedSessionId === DRAFT_TILE_KEY)) {
    return
  }

  // Already open as its own tile (the draft was abandoned onto an existing
  // chat): drop the draft rather than creating a duplicate tab for one session.
  if (tiles.some(t => t.storedSessionId === storedSessionId)) {
    saveTiles(tiles.filter(t => t.storedSessionId !== DRAFT_TILE_KEY))

    return
  }

  renameTreePane(DRAFT_TILE_PANE_ID, `${TILE_PANE_PREFIX}${storedSessionId}`)
  saveTiles(tiles.map(t => (t.storedSessionId === DRAFT_TILE_KEY ? { ...t, storedSessionId } : t)))
}

/**
 * Front the MAIN chat and make its zone the focused one.
 *
 * The workspace half of `focusOpenSession`, extracted because a NEW session
 * needs exactly this and the two must not drift (MJXHRM-6).
 *
 * It names the workspace's real group rather than `null` on purpose. The passive
 * `$activeStoredSessionId` listener below homes to `null`, which leaves
 * `activateTreeTabSlot` / `cycleTreeTabInFocusedZone` inert — they read
 * `$activeTreeGroup` raw, with none of `closeFocusedTabInZone`'s main-pane
 * fallback — so ⌥1-9 and ⌃Tab could not switch between two tabs the user was
 * looking at. An explicit focus act claims the zone; passive navigation does not.
 */
export function focusWorkspaceSession(): void {
  revealTreePane(WORKSPACE_PANE_ID)

  const tree = $layoutTree.get()

  noteActiveTreeGroup(tree ? (findGroupOfPane(tree, WORKSPACE_PANE_ID)?.id ?? null) : null)
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
    focusWorkspaceSession()

    return true
  }

  return false
}

// Closed-tab stack for ⌘⇧T reopen (in-memory), keyed PER PROFILE.
const closedTilesByProfile: Record<string, SessionTile[]> = {}
const closedStack = (): SessionTile[] => (closedTilesByProfile[profileKey()] ??= [])

export function closeSessionTile(storedSessionId: string) {
  const tile = $sessionTiles.get().find(t => t.storedSessionId === storedSessionId)

  // The draft is not reopenable: ⌘⇧T would restore a tab for a chat that never
  // existed. Closing an empty draft discards it, which is what closing an empty
  // draft means.
  if (tile && storedSessionId !== DRAFT_TILE_KEY) {
    closedStack().push({ anchor: tile.anchor, before: tile.before, dir: tile.dir, storedSessionId })
  }

  saveTiles($sessionTiles.get().filter(t => t.storedSessionId !== storedSessionId))
}

/**
 * Would closing this SLICE drop work in flight — a running turn, a reply on the
 * way, or a prompt waiting on the user?
 *
 * Exported because a session is closeable from two unrelated surfaces (a
 * layout-tree TILE and a mobile BUBBLE) and only one of them used to ask. The
 * predicate is the thing they have to share; what they do with the answer goes
 * through `requestClose` (store/close-confirm). It takes a runtime KEY rather
 * than a stored id because the two surfaces resolve that key differently — a
 * tile through `tileRuntimeKey`, a bubble through `bubbleRuntimeKey` — and
 * forcing one resolver on both is how a bubble would end up reading the wrong
 * session's busy flag.
 */
export function sessionKeyNeedsCloseConfirm(runtimeKey: null | string): boolean {
  const state = runtimeKey ? $sessionStates.get()[runtimeKey] : undefined

  return Boolean(state?.busy || state?.awaitingResponse || state?.needsInput)
}

/** Close a tile — but confirm first if its session is still working / waiting.
 *  The key is resolved through the reverse index rather than the tile's cached
 *  runtimeId, so a session whose stored id rotated under a background compaction
 *  is still recognised as busy instead of closing without a prompt (MJX-133). */
export function requestCloseSessionTile(storedSessionId: string): void {
  requestClose(
    { close: () => closeSessionTile(storedSessionId), id: storedSessionId, kind: 'session' },
    sessionKeyNeedsCloseConfirm(tileRuntimeKey(storedSessionId))
  )
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

/** ⌘⇧T — reopen the most recently closed tab where it was, then FOCUS it.
 *  Adoption alone is silent (it must not steal the active tab), so restore has
 *  to front the pane explicitly or the tab comes back behind whatever you were
 *  looking at. Skips ids that are live again (reopened / now the primary). */
export function reopenLastClosedTile(): void {
  const stack = closedStack()

  for (let tile = stack.pop(); tile; tile = stack.pop()) {
    const { storedSessionId } = tile

    if (storedSessionId === $activeStoredSessionId.get()) {
      continue
    }

    if (!$sessionTiles.get().some(t => t.storedSessionId === storedSessionId)) {
      openSessionTile(storedSessionId, tile.dir, tile.anchor, tile.before)
      focusOpenSession(storedSessionId)

      return
    }
  }
}

/** The open tab that is still an empty "New session" draft, if there is one.
 *  That tab is the one the user would have typed into, so an open-from-nowhere
 *  SPENDS it instead of stacking a second blank tab beside it. Most recent
 *  wins; a tile whose runtime hasn't bound (or whose state hasn't published) is
 *  unknown rather than empty, so it is left alone. */
export function blankDraftTile(
  tiles: readonly SessionTile[],
  states: Record<string, ClientSessionState>
): null | SessionTile {
  // Reverse scan rather than `findLast` — this project's lib target predates it.
  for (let i = tiles.length - 1; i >= 0; i--) {
    const key = tileRuntimeKey(tiles[i].storedSessionId)
    const state = key ? states[key] : undefined

    if (state && !state.busy && state.messages.length === 0) {
      return tiles[i]
    }
  }

  return null
}

/** Hand an open blank draft tab over to `storedSessionId`, keeping its slot.
 *  False when there is no such tab, so the caller can fall back. The spent
 *  draft is DISCARDED rather than closed: it never held a conversation, so ⌘⇧T
 *  resurrecting it would just restore an empty tab. */
export function reuseBlankDraftTile(storedSessionId: string): boolean {
  const tile = blankDraftTile($sessionTiles.get(), $sessionStates.get())

  if (!tile || tile.storedSessionId === storedSessionId) {
    return false
  }

  discardSessionTile(tile.storedSessionId)
  openSessionTile(storedSessionId, tile.dir, tile.anchor, tile.before)
  revealTreePane(`${TILE_PANE_PREFIX}${storedSessionId}`)

  return true
}

/**
 * The session tile that should shift INTO main when the workspace tab closes:
 * the nearest chat tab in main's own strip, scanning right first and then left
 * (the tab that fills the slot, then its neighbour). Null when main is the only
 * chat in its zone — the caller then drops main to a fresh draft.
 */
export function nextSessionTileForWorkspace(): null | string {
  const tree = $layoutTree.get()
  const group = tree ? findGroupOfPane(tree, WORKSPACE_PANE_ID) : null

  if (!group) {
    return null
  }

  const tiles = $sessionTiles.get()
  const idx = group.panes.indexOf(WORKSPACE_PANE_ID)
  // After the workspace tab first, then the ones before it (nearest-out).
  const ordered = [...group.panes.slice(idx + 1), ...group.panes.slice(0, idx).reverse()]

  for (const paneId of ordered) {
    const storedSessionId = storedIdFromTilePane(paneId)

    if (storedSessionId && tiles.some(t => t.storedSessionId === storedSessionId)) {
      return storedSessionId
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// The FOCUSED session — one derivation. The layout's interaction tracker
// ($activeTreeGroup) resolves to a zone; its active pane names the session: a
// `session-tile:<storedId>` pane IS that session, anything else falls back to the
// route-driven active session.
// ---------------------------------------------------------------------------

/**
 * The last interacted zone that actually HOSTS a chat.
 *
 * `$activeTreeGroup` moves on every pointerdown/focusin anywhere in the tree, so
 * clicking a folder in the file tree — or the terminal, or the review pane —
 * makes a non-chat zone the interacted one, and the derivation below would fall
 * straight back to the sidebar's selection. Everything keyed on "the focused
 * session" would then bounce between the tile you were reading and whatever the
 * sidebar last picked, every time you touched a side pane.
 *
 * Zones hosting the workspace count: the main pane's session IS the selection,
 * so falling back there is the right answer rather than a stale one.
 */
const $chatTreeGroup = atom<null | string>(null)

$activeTreeGroup.subscribe(groupId => {
  const tree = $layoutTree.get()
  const active = groupId && tree ? findGroup(tree, groupId)?.active : undefined

  if (active === WORKSPACE_PANE_ID || active?.startsWith(TILE_PANE_PREFIX)) {
    $chatTreeGroup.set(groupId)
  }
})

/** Pane id of the FOCUSED chat surface — the interacted chat zone's tile, else
 *  the workspace. The composer focus bus resolves `'active'` through this, so
 *  typing lands in the chat you are looking at rather than the one that mounted
 *  last. */
export const $focusedChatPane = computed([$chatTreeGroup, $layoutTree], (groupId, tree) => {
  const active = groupId && tree ? findGroup(tree, groupId)?.active : undefined

  return active?.startsWith(TILE_PANE_PREFIX) ? active : WORKSPACE_PANE_ID
})

/** Stored id of the focused session (the interacted chat zone's tile, else the active one). */
export const $focusedStoredSessionId = computed(
  [$focusedChatPane, $activeStoredSessionId],
  (pane, selected) => storedIdFromTilePane(pane) ?? selected
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

/** The focused chat's project directory — `''` for a detached chat. What the
 *  workspace surfaces (file tree, review, terminal, statusbar) point at, via
 *  `$effectiveCwd` in store/workspace-events, which adds the root fallback. */
export const $focusedCwd = computed($focusedSessionState, state => state.cwd)

/** A PRIMARY navigation homes focus to the workspace — UNLESS the selected id is
 *  already an open TILE (where `focusOpenSession` owns the move). */
export const selectionHomesToWorkspace = (selected: null | string, tiles: readonly SessionTile[]): boolean =>
  !(selected && tiles.some(t => t.storedSessionId === selected))

$activeStoredSessionId.listen(selected => {
  if (!selectionHomesToWorkspace(selected, $sessionTiles.get())) {
    return
  }

  // `null`, not the workspace's group, on purpose: this fires on EVERY primary
  // navigation (a sidebar row, a deep link, a delete, a profile switch), and
  // claiming a zone here would make ⌃Tab cycle the main strip instead of opening
  // the recent-session HUD, and ⌥1-9 activate tabs instead of jumping to recent
  // sessions. An explicit act — `focusWorkspaceSession` — claims the zone.
  noteActiveTreeGroup(null)
  revealTreePane(WORKSPACE_PANE_ID)
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
