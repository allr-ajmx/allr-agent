import { COMMAND_CENTER_ROUTE } from '@/app/routes'
import {
  deleteSession,
  getSession,
  getSessionMessages,
  listAllProfileSessions,
  renameSession,
  searchSessions,
  setSessionArchived
} from '@/hermes'
import { translateNow } from '@/i18n'
import { isNotFoundError } from '@/lib/api'
import { chatMessageText } from '@/lib/chat-messages'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { appendLiveSessionProjection, toChatMessages } from '@/lib/session-history'
import { stableArray } from '@/lib/stable-array'
import { readJson, writeJson } from '@/lib/storage'
import { reuseUnchanged } from '@/lib/structural-share'
import { atom, computed } from '@/store/atom'
import { $busy, $clarify, $currentCwd, $messages, $sessionId, type ChatMessage, resetChat } from '@/store/chat'
import { resetUnscopedStreamPin } from '@/store/event-router'
import { requestGateway } from '@/store/gateway'
import { $pinnedSessionIds } from '@/store/layout'
import { $liveSessionStatuses } from '@/store/live-session-registry'
import { notify, notifyError } from '@/store/notifications'
import { flashPetActivity } from '@/store/pet'
// Import direction is `session.ts → profile.ts → profiles.ts`; never the reverse.
import { $activeGatewayProfile, $profileScope, ALL_PROFILES, normalizeProfileKey } from '@/store/profile'
import { $profiles } from '@/store/profiles'
import {
  $activeSessionKey,
  $sessionStates,
  type ClientSessionState,
  dropSessionState,
  ensureSessionSlice,
  hydratingKey,
  isPlaceholderKey,
  rekeySession,
  runtimeKeyForStoredSession,
  updateSession
} from '@/store/session-state-types'
import { adoptResumedTurn, resumedTurnIsLive } from '@/store/turn-lifecycle'
import { openAppRoute, ownsPersistedAppState } from '@/store/windows'
import type { SessionCreateResponse, SessionInfo, SessionResumeResponse, SessionSearchResult } from '@/types/hermes'

// Session history + switching (Hc2). Lean adaptation of desktop store/session.ts —
// no windows/projects/pins/profiles/branch/cwd/model. Two ids: the STORED id
// (list rows, $activeStoredSessionId) vs the RUNTIME id ($sessionId in chat.ts,
// what prompt.submit targets), bound by session.resume.

const PAGE = 30

/** Where the pinned-row fallback cache lives (see `$pinnedSessionCache`). */
const PINNED_CACHE_KEY = 'hermes.pinnedSessionRows'

export const $sessions = atom<SessionInfo[]>([])
/** Counts SUCCESSFUL full-window refreshes. See `refreshSessions`. */
export const $sessionsListEpoch = atom(0)
export const $sessionsLoading = atom(false)
export const $sessionsTotal = atom(0)
export const $sessionsLimit = atom(PAGE)
export const $activeStoredSessionId = atom<null | string>(null)
// Compat alias for ported desktop code (`@/store/session` → `$activeSessionId`).
// Universal's stored id IS the desktop "active session" id for a single-session app.
export const $activeSessionId = $activeStoredSessionId

// The last chat that was actually open, remembered across launches — PER
// PROFILE.
//
// A phone always cold-starts at "/" — there is no window to restore and no URL
// to come back to — so without this the app opened on an empty new session every
// time, and the chat you were in the middle of was three taps away in the
// sidebar. Written on every switch, read once at boot (see
// `use-restore-last-session`).
//
// One global key remembered ONE session across every profile, so booting under
// profile B restored a session owned by profile A — which then resumed against
// B's backend and forked the conversation into the wrong profile's database.
// Keyed by the session's OWNING profile instead (the aggregator tags every row),
// so each profile remembers its own place. The old global key is deliberately
// NOT migrated: which profile owned that value is unknowable, and guessing is
// exactly the cross-profile bleed this scoping exists to prevent.
//
// A draft (null) is deliberately NOT recorded: an unsaved chat has nothing to
// restore, and letting it overwrite the value would mean opening a new session
// once wiped out the memory of the last real one. A secondary window never
// writes — it does not own the user's place in the app.
const LAST_SESSION_KEY = 'hermes.lastSessionId.byProfile'

const $lastSessionByProfile = persistentAtom<Record<string, string>>(LAST_SESSION_KEY, {}, Codecs.stringRecord)

if (ownsPersistedAppState()) {
  $activeStoredSessionId.subscribe(id => {
    if (!id) {
      return
    }

    const owner = knownSessionProfile(id) ?? $activeGatewayProfile.get()
    const current = $lastSessionByProfile.get()

    if (current[owner] !== id) {
      $lastSessionByProfile.set({ ...current, [owner]: id })
    }
  })
}

/** The session to land on at boot, if any — the one last open on THIS profile. */
export function lastOpenedSessionId(): null | string {
  return $lastSessionByProfile.get()[$activeGatewayProfile.get()] ?? null
}

// ---------------------------------------------------------------------------
// OWNING PROFILE — which profile's database a stored session actually lives in.
//
// Every session-scoped call (resume, transcript read, delete, archive, rename)
// is served by ONE profile's backend. Sent without a profile it lands on
// whichever gateway is live, so opening a session from another profile resumed
// against the wrong database and forked the conversation into it. The REST layer
// has taken an optional `profile` all along (see hermes.ts); universal simply
// never passed one.
// ---------------------------------------------------------------------------

/** Resolutions we paid a lookup for. A session's owner never changes, so this is
 *  a permanent answer, and it keeps a cold tab switch off the network. */
const profileByStoredId = new Map<string, string>()

/** Drop the resolution cache. The keys are profile NAMES, so a renamed, removed
 *  or newly created profile can make every remembered answer stale. */
export function clearSessionProfileCache(): void {
  profileByStoredId.clear()
}

$profiles.listen(clearSessionProfileCache)

/** The owning profile we ALREADY know, with no network round-trip: the row's own
 *  stamp, or a previous resolution. Used where an await would be wrong (the
 *  remembered-id subscriber) or wasteful (an optimistic mutation). */
export function knownSessionProfile(storedSessionId: string): string | undefined {
  const cached = $sessions
    .get()
    .find(session => sessionMatchesStoredId(session, storedSessionId))
    ?.profile?.trim()

  return cached || profileByStoredId.get(storedSessionId)
}

/**
 * Whether a session's owner is worth PROBING for.
 *
 * With one profile configured there is no wrong answer to route around, and the
 * calls behave exactly as they always did without a `profile`. Callers check
 * this so the common open stays synchronous: awaiting a resolution that can only
 * return `undefined` would defer every resume by a microtask for nothing.
 */
export function sessionProfileIsAmbiguous(): boolean {
  return $profiles.get().length > 1
}

/**
 * Resolve the profile a stored session belongs to, probing the backends if the
 * loaded rows can't answer.
 *
 * The cross-profile aggregator stamps `profile` on every row it returns, so the
 * sidebar's own sessions answer for free. A session OUTSIDE the loaded window —
 * right-clicked from search, restored from a tile, opened by id — is a cache
 * miss, and with several profiles configured a miss cannot be assumed to be the
 * active one. Each probe is a single by-id lookup that 404s when the id isn't on
 * that profile, which is far cheaper than pulling every profile's recents.
 */
export async function resolveSessionProfile(storedSessionId: null | string): Promise<string | undefined> {
  if (!storedSessionId) {
    return undefined
  }

  const known = knownSessionProfile(storedSessionId)

  if (known || !sessionProfileIsAmbiguous()) {
    return known
  }

  const activeKey = $activeGatewayProfile.get()

  const others = $profiles
    .get()
    .map(profile => normalizeProfileKey(profile.name))
    .filter(key => key !== activeKey)

  // The active profile first, unscoped — one row lookup that covers every
  // single-profile install and any id on the live backend.
  const candidates: (string | undefined)[] = [undefined, ...others]

  for (const candidate of candidates) {
    try {
      const session = await getSession(storedSessionId, candidate)
      const owner = normalizeProfileKey(session.profile?.trim() || candidate || activeKey)

      profileByStoredId.set(storedSessionId, owner)

      return owner
    } catch {
      // Not on this profile — keep probing. A total miss falls through to
      // `undefined`, which is the pre-existing "let the gateway decide" path.
    }
  }

  return undefined
}

/** What the backends say about an id. `unknown` is NOT `gone`: see below. */
export type SessionExistence = 'gone' | 'present' | 'unknown'

/**
 * Ask every backend whether a stored id still exists.
 *
 * ABSENCE FROM A LIST IS NOT PROOF OF DELETION — an archived session is absent
 * too (the `include_pinned` back-fill in `hermes_state.py list_sessions_rich`
 * obeys the archived filter), and so is a session belonging to a profile the
 * current scope doesn't cover. Acting on the inference would unpin every
 * archived-but-pinned chat. This is the positive signal instead: a by-id GET
 * 404s only when the row is really not in that profile's state.db, and returns
 * archived rows just like live ones (`get_session_detail` reads the row, not the
 * list).
 *
 * Every configured profile is probed, because a pin is not profile-scoped while
 * the recents list is. Only an answer from ALL of them is `gone`; a transport
 * failure, a dead gateway or a 500 anywhere is `unknown`, and callers must treat
 * that as "ask again later" rather than as a deletion.
 */
export async function sessionExistsOnBackends(storedSessionId: string): Promise<SessionExistence> {
  const activeKey = $activeGatewayProfile.get()

  const others = sessionProfileIsAmbiguous()
    ? $profiles
        .get()
        .map(profile => normalizeProfileKey(profile.name))
        .filter(key => key !== activeKey)
    : []

  // Unscoped first — one lookup covers every single-profile install.
  for (const candidate of [undefined, ...others]) {
    try {
      await getSession(storedSessionId, candidate)

      return 'present'
    } catch (err) {
      if (!isNotFoundError(err)) {
        // No answer (offline, timeout, 5xx, not connected). Anything but a 404
        // leaves the question open — and a caller acting on it would delete
        // user state over a dropped packet.
        return 'unknown'
      }
    }
  }

  return 'gone'
}

// ---------------------------------------------------------------------------
// TOMBSTONES — ids the user just deleted or archived.
//
// The optimistic removal from `$sessions` is instant, but the backend's next
// list page is a snapshot that may predate the mutation, so a refresh landing
// mid-flight put the row straight back. These are the client-side eviction: a
// refreshed page is filtered through them, and a tombstone only lifts once the
// mutation has settled AND the backend has stopped listing the id.
// ---------------------------------------------------------------------------

export const $removedSessionIds = atom<ReadonlySet<string>>(new Set())

/** Ids whose delete/archive RPC is still in flight. Their tombstones are PINNED:
 *  a snapshot taken before the mutation landed must not lift them. */
const mutatingSessionIds = new Set<string>()

function editIdSet(current: ReadonlySet<string>, ids: readonly (null | string | undefined)[], add: boolean) {
  const next = new Set(current)

  for (const id of ids) {
    const trimmed = id?.trim()

    if (trimmed) {
      add ? next.add(trimmed) : next.delete(trimmed)
    }
  }

  return next.size === current.size ? null : next
}

export function tombstoneSessions(ids: readonly (null | string | undefined)[]): void {
  const next = editIdSet($removedSessionIds.get(), ids, true)

  if (next) {
    $removedSessionIds.set(next)
  }
}

/** Undo a tombstone — the mutation failed and its row is back. */
export function untombstoneSessions(ids: readonly (null | string | undefined)[]): void {
  const next = editIdSet($removedSessionIds.get(), ids, false)

  if (next) {
    $removedSessionIds.set(next)
  }
}

function markSessionMutation(ids: readonly (null | string | undefined)[], inFlight: boolean): void {
  for (const id of ids) {
    const trimmed = id?.trim()

    if (trimmed) {
      inFlight ? mutatingSessionIds.add(trimmed) : mutatingSessionIds.delete(trimmed)
    }
  }
}

export function isTombstonedSession(id: null | string | undefined): boolean {
  const trimmed = id?.trim()

  return Boolean(trimmed && $removedSessionIds.get().has(trimmed))
}

/**
 * Strip rows the user just removed.
 *
 * Used on a freshly fetched recents page AND at render for the project tree,
 * whose lanes come straight from the backend snapshot rather than from
 * `$sessions` — without the overlay a deleted chat stayed in its lane until the
 * next `projects.tree`, i.e. the flat list and the tree disagreed about whether
 * it existed. Subscribe to `$removedSessionIds` at the render site so the
 * overlay lifts with the tombstone.
 */
export function withoutTombstoned(sessions: SessionInfo[]): SessionInfo[] {
  return $removedSessionIds.get().size === 0
    ? sessions
    : sessions.filter(session => !isTombstonedSession(session.id) && !isTombstonedSession(session._lineage_root_id))
}

/**
 * Lift tombstones the backend has caught up with. `stillListed` is whatever the
 * server just said exists — a refreshed page, or `projects.tree`'s scoped ids.
 * A tombstone survives while the id is still listed (the delete hasn't landed on
 * their side) or while its own mutation is in flight, so nothing flashes back.
 */
export function pruneSessionTombstones(stillListed: Iterable<string>): void {
  const current = $removedSessionIds.get()

  if (current.size === 0) {
    return
  }

  const listed = new Set(stillListed)
  const pending = new Set([...current].filter(id => listed.has(id) || mutatingSessionIds.has(id)))

  if (pending.size !== current.size) {
    $removedSessionIds.set(pending)
  }
}

export const $sessionSearch = atom<SessionSearchResult[]>([])
export const $searchLoading = atom(false)

// Stored ids that finished a turn in the BACKGROUND (a tile, not the focused
// session) — the sidebar's "finished while you were away" marker. Written by
// `store/session-states.ts#handleTransition`; a view clears its id when seen.
export const $unreadFinishedSessionIds = atom<string[]>([])

export function clearUnreadFinishedSession(storedSessionId: string): void {
  const cur = $unreadFinishedSessionIds.get()

  if (cur.includes(storedSessionId)) {
    $unreadFinishedSessionIds.set(cur.filter(id => id !== storedSessionId))
  }
}

/** Drop every "finished while you were away" marker at once — the sidebar
 *  filter menu's "Mark all as read". Skips the write when there is nothing to
 *  clear, so it can't churn subscribers on a repeated press. */
export function markAllSessionsRead(): void {
  if ($unreadFinishedSessionIds.get().length) {
    $unreadFinishedSessionIds.set([])
  }
}

// Opening a session clears its unread state — the user is now looking at it.
// Hung off the atom rather than the several `openSession`/`hydrateColdSession`
// call sites so it exactly mirrors the mark, which `session-states.ts#handleTransition`
// gates on this same atom: a turn that settles while its session ISN'T active
// becomes unread, and the moment it becomes active it stops being.
$activeStoredSessionId.listen(storedId => {
  if (storedId) {
    clearUnreadFinishedSession(storedId)
  }
})

/** Follow a compression-driven stored-id rotation for the LIVE primary runtime
 *  (auto-compression mints a new session id mid-turn). Guarded by provenance so
 *  a stale background rotation can't steal the foreground selection. Called by
 *  `session-states.ts#handleTransition`. */
export function setActiveSessionStoredIdRotation(rotation: {
  nextStoredSessionId: string
  previousStoredSessionId: string
  runtimeSessionId: string
}): void {
  if (rotation.runtimeSessionId !== $sessionId.get()) {
    return
  }

  if ($activeStoredSessionId.get() !== rotation.previousStoredSessionId) {
    return
  }

  $activeStoredSessionId.set(rotation.nextStoredSessionId)
}

// Sidebar row state — the UNION of the primary (single active chat), every open
// TILE, and every session the gateway says is live that this client holds no
// slice for. "working" = a session streaming a turn; "needs input" = a session
// with a clarify prompt pending. The tile slices come from `$sessionStates`
// (tiles only); the primary comes from the global `$busy`/`$clarify`; the rest
// come from `$liveSessionStatuses` — a cron tick, an inbound messaging turn, the
// TUI. That third source used to be a `$sessionStates` slice minted from the
// liveness snapshot, which made every warm short-circuit treat an unopened
// session as already hydrated (MJXHRM-356). Guarded with `stableArray` so the
// per-token republish of `$sessionStates` doesn't re-render the sidebar unless
// membership actually changed.
//
// A session THIS client holds a slice for answers for itself, even when the
// snapshot also lists it: the slice settles on the terminal frame, where the
// snapshot trails by a poll interval, so preferring it is what keeps a finished
// turn's spinner from lingering for up to 30 seconds.
const storedIdsWithSlices = (states: Record<string, ClientSessionState>): Set<string> => {
  const owned = new Set<string>()

  for (const state of Object.values(states)) {
    if (state.storedSessionId) {
      owned.add(state.storedSessionId)
    }
  }

  return owned
}

let workingArr: readonly string[] = []
let workingSet = new Set<string>()
export const $workingSessionIds = computed(
  [$busy, $activeStoredSessionId, $sessionStates, $liveSessionStatuses],
  (busy, activeId, states, live) => {
    const next: string[] = []

    if (busy && activeId) {
      next.push(activeId)
    }

    for (const s of Object.values(states)) {
      if (s.busy && s.storedSessionId && !next.includes(s.storedSessionId)) {
        next.push(s.storedSessionId)
      }
    }

    const owned = storedIdsWithSlices(states)

    for (const storedSessionId of Object.keys(live)) {
      if (!owned.has(storedSessionId) && !next.includes(storedSessionId)) {
        next.push(storedSessionId)
      }
    }

    const stable = stableArray(workingArr, next)

    if (stable !== workingArr) {
      workingArr = stable
      workingSet = new Set(stable)
    }

    return workingSet
  }
)

let attentionArr: readonly string[] = []
export const $attentionSessionIds = computed(
  [$clarify, $activeStoredSessionId, $sessionStates, $liveSessionStatuses],
  (clarify, activeId, states, live) => {
    const next: string[] = []

    if (clarify && activeId) {
      next.push(activeId)
    }

    for (const s of Object.values(states)) {
      if (s.needsInput && s.storedSessionId && !next.includes(s.storedSessionId)) {
        next.push(s.storedSessionId)
      }
    }

    const owned = storedIdsWithSlices(states)

    for (const [storedSessionId, status] of Object.entries(live)) {
      if (status === 'waiting' && !owned.has(storedSessionId) && !next.includes(storedSessionId)) {
        next.push(storedSessionId)
      }
    }

    return (attentionArr = stableArray(attentionArr, next))
  }
)

// `$activeSessionTitle` used to sit here, documented as "drives the topbar".
// Nothing had ever consumed it — the topbar's title is `ChatTitle` — and it
// resolved the active session with `sessions.find(s => s.id === activeId)`:
// the paginated recents page, compared by live id alone. Both halves of exactly
// the bug MJXHRM-386 is about, sitting in the store as a ready-made trap for
// the next caller who trusted the comment. `ChatTitle` resolves through
// `useSessionRow` instead; a future headless caller wants `sessionRowFor`.

/** Functional setter for optimistic row edits (rename dialog etc.). */
export function setSessions(updater: (prev: SessionInfo[]) => SessionInfo[]): void {
  $sessions.set(updater($sessions.get()))
}

/**
 * Last-known row for every session the user has PINNED, keyed by pin id.
 *
 * A pinned row used to be resolved out of `$sessions` alone, so a pin whose
 * session sat past the loaded page simply vanished from the Pinned section —
 * pin a chat, scroll on, refresh, and it is gone even though the pin is still
 * stored. The list is a WINDOW; the pin is not, and the section must show every
 * pinned session regardless of how deep it has fallen.
 *
 * The backend's own "back-fill pinned rows past offset+limit" (`include_pinned`)
 * covers this once a pin has reached `sessions.pinned` — which it now does, via
 * store/session-pin-sync.ts. This cache remains the fallback for the window
 * where it has not: a pin made offline or against a backend predating the flag,
 * and the first paint after a reload, before any page has landed. Every page
 * carrying a pinned row refreshes its entry, and the entry outlives the row's
 * departure from the window.
 *
 * Persisted so the section survives a reload, where `$sessions` starts empty and
 * the first page may not reach far enough back to re-cover the pins.
 */
export const $pinnedSessionCache = atom<Readonly<Record<string, SessionInfo>>>(
  readJson<Record<string, SessionInfo>>(PINNED_CACHE_KEY) ?? {}
)

/** Refresh the cache from whatever rows are currently loaded, and drop entries
 *  whose pin is gone. Called on every list write, so unpinning forgets the row
 *  rather than leaving it to accumulate. */
export function syncPinnedSessionCache(): void {
  const pinned = new Set($pinnedSessionIds.get())
  const current = $pinnedSessionCache.get()
  const next: Record<string, SessionInfo> = {}
  let changed = false

  for (const [pinId, session] of Object.entries(current)) {
    if (pinned.has(pinId)) {
      next[pinId] = session
    } else {
      changed = true
    }
  }

  for (const session of $sessions.get()) {
    const pinId = sessionPinId(session)

    if (pinned.has(pinId) && next[pinId] !== session) {
      next[pinId] = session
      changed = true
    }
  }

  if (changed) {
    $pinnedSessionCache.set(next)
    writeJson(PINNED_CACHE_KEY, next)
  }
}

/**
 * Forget every cached pinned ROW, because the backend they came from is gone.
 *
 * The pin IDS stay: they are this app's mirror of `sessions.pinned` in each
 * gateway's own state.db, and the next gateway re-asserts its own set through
 * `store/session-pin-sync.ts` (which also re-adopts them on the way back). The
 * rows are the part that is gateway-bound — a session id means nothing on
 * another backend — so leaving them behind rendered the PREVIOUS gateway's
 * conversations in the new one's Pinned section, resolvable by nothing and
 * openable to nothing. Same reasoning as every other wipe in
 * `wipeSessionListsForGatewaySwitch`.
 */
export function clearPinnedSessionCache(): void {
  $pinnedSessionCache.set({})
  writeJson(PINNED_CACHE_KEY, {})
}

/** Every pinned session, in pin order — loaded rows first, falling back to the
 *  last-known row for a pin that has fallen out of the loaded window.
 *
 *  Tombstoned ids are dropped (MJXHRM-414). The cache fallback is what makes
 *  this list survive pagination, and it is also what let a DELETED session go on
 *  rendering here: the row leaves `$sessions`, the cache still has it, and the
 *  pin was never released. Unpin-on-delete is the real fix; this is the belt to
 *  its braces, and it also covers the in-flight window before the RPC lands. */
export function pinnedSessionRows(sessions: readonly SessionInfo[], pinnedIds: readonly string[]): SessionInfo[] {
  const byPinId = new Map(sessions.map(session => [sessionPinId(session), session]))
  const cache = $pinnedSessionCache.get()

  return pinnedIds
    .filter(id => !isTombstonedSession(id))
    .map(id => byPinId.get(id) ?? cache[id])
    .filter((s): s is SessionInfo => Boolean(s) && !isTombstonedSession(s.id))
}

// One subscription each rather than a call at every write site: a pinned row can
// be refreshed by a list page, a title patch, an optimistic insert or a
// tombstone lift, and a site that forgot to sync would silently show a stale
// pinned row forever. Declared BELOW the atom — nanostores fires `subscribe`
// immediately, so wiring these any earlier reads the cache before it exists.
$sessions.subscribe(() => syncPinnedSessionCache())
$pinnedSessionIds.subscribe(() => syncPinnedSessionCache())

/** Durable pin key: the lineage-root id survives auto-compression's id rotation. */
export function sessionPinId(session: SessionInfo): string {
  return session._lineage_root_id ?? session.id
}

/** True when a stored/lineage id resolves to this session — it matches either
 *  the live id or the stable lineage root (see sessionPinId). Verbatim from
 *  desktop store/session.ts. */
export const sessionMatchesStoredId = (
  session: Pick<SessionInfo, '_lineage_root_id' | 'id'>,
  storedSessionId: string
): boolean => session.id === storedSessionId || session._lineage_root_id === storedSessionId

/**
 * Do two stored ids name the SAME conversation?
 *
 * The mirror of `sessionMatchesStoredId`: that one asks whether an id names a
 * row you already have, this one asks whether two ids — held by two different
 * surfaces, neither carrying a row — are the same chat. Auto-compression rotates
 * the stored id and universal deliberately leaves layout keys on the old one, so
 * a tile opened before a compaction is keyed on the lineage root while the
 * sidebar row beside it renders under the live tip. Compared on identity,
 * "Open in tile" from that row did not see the tile that was already open and
 * added a SECOND tab for the same live conversation — both tabs resolving to one
 * `$sessionStates` slice through the stored-id index (MJXHRM-423).
 *
 * Answered from `$sessions` alone, deliberately: this is called from synchronous
 * layout code, and the surface that can produce the mismatch (a sidebar row, a
 * search hit) is by definition rendering a row that is loaded. An id no loaded
 * row explains is only equal to itself, which is where this started.
 */
export function sameStoredSession(a: null | string, b: null | string): boolean {
  if (!a || !b) {
    return false
  }

  if (a === b) {
    return true
  }

  const row = $sessions.get().find(session => sessionMatchesStoredId(session, a))

  return Boolean(row && sessionMatchesStoredId(row, b))
}

/**
 * EVERY id that names this conversation: the one the caller is holding, plus
 * the resolved row's live tip and its durable lineage root.
 *
 * Auto-compression ROTATES a session's stored id, and universal deliberately
 * does not rename the surfaces holding the old one — tiles, mobile bubbles,
 * layout pane ids and the persisted `hermes.*` blobs all keep the pre-rotation
 * id, and the stored-id index aliases them onto the live slice instead
 * (MJX-133, `store/session-state-types.ts`). Row LOOKUP has always followed
 * that (`sessionMatchesStoredId`), but the live-status collections are keyed by
 * the slice's CURRENT stored id alone, so anything asking them under the old id
 * — a tile tab's status dot, a bubble's badge — read `idle` straight through a
 * running turn, and missed needs-input and unread with it. Ask under every
 * alias, exactly as desktop's `$sessionDotStateById` claims under every one.
 *
 * Same id/root equivalence the rest of universal uses, so no caller gains an
 * answer the row lookup would disagree with.
 */
export function sessionAliasIds(
  storedSessionId: null | string,
  session?: null | Pick<SessionInfo, '_lineage_root_id' | 'id'>
): string[] {
  const ids: string[] = []

  for (const id of [storedSessionId, session?.id, session?._lineage_root_id]) {
    if (id && !ids.includes(id)) {
      ids.push(id)
    }
  }

  return ids
}

// `toggleSelectedPin` (the `session.togglePin` keybind) lives in
// `store/session-lookup`: it has to resolve the active session's DURABLE pin id
// through the wide row lookup, and that module cannot be imported from here
// without a cycle (it reads `$projectTree`, and `store/projects` already imports
// this file).

// ── Messaging-platform sessions (Discord, Telegram, …) ──────────────────────
//
// KEEP IN SYNC with `PLATFORM_ICONS` in app/messaging/platform-icon.tsx. The two
// halves answer different questions — "does this session belong in the messaging
// section" and "what does that platform look like" — and a platform present in
// only one of them is invisible in the other: `photon` and `buzz` had icons and
// setup copy but no entry here, so their sessions were never grouped out of
// recents at all (reported by SE-H alongside MJXHRM-44).
const MESSAGING_SOURCES = new Set([
  'api_server',
  'bluebubbles',
  'buzz',
  'discord',
  'email',
  'homeassistant',
  'matrix',
  'mattermost',
  'photon',
  'qqbot',
  'signal',
  'slack',
  'sms',
  'telegram',
  'webhook',
  'weixin',
  'whatsapp',
  'yuanbao'
])

export function isMessagingSource(source: null | string): boolean {
  return !!source && MESSAGING_SOURCES.has(source.toLowerCase())
}

const MESSAGING_SOURCE_LABELS: Record<string, string> = {
  api_server: 'API',
  bluebubbles: 'iMessage',
  buzz: 'Buzz',
  discord: 'Discord',
  email: 'Email',
  homeassistant: 'Home Assistant',
  matrix: 'Matrix',
  mattermost: 'Mattermost',
  photon: 'Photon',
  qqbot: 'QQ',
  signal: 'Signal',
  slack: 'Slack',
  sms: 'SMS',
  telegram: 'Telegram',
  webhook: 'Webhook',
  weixin: 'WeChat',
  whatsapp: 'WhatsApp',
  yuanbao: 'Yuanbao'
}

export function messagingSourceLabel(source: string): string {
  return MESSAGING_SOURCE_LABELS[source.toLowerCase()] ?? source.charAt(0).toUpperCase() + source.slice(1)
}

export const $messagingSessions = atom<SessionInfo[]>([])

// Cross-platform messaging sessions, kept in their own slice so a busy platform
// doesn't crowd out the recents page (they're excluded from the recents fetch).
export async function refreshMessagingSessions(): Promise<void> {
  try {
    const res = await listAllProfileSessions(100, 1, 'exclude', 'recent', 'all', { excludeSources: ['cron'] })
    // Same identity gate as `refreshSessions` (MJXHRM-383) — the messaging lanes
    // render the same memoized `SidebarSessionRow`, on the same poll.
    $messagingSessions.set(
      reuseUnchanged(
        $messagingSessions.get(),
        (res.sessions ?? []).filter(session => isMessagingSource(session.source))
      )
    )
  } catch {
    // Best-effort; keep the last known slice.
  }
}

// Recents come from the cross-profile aggregator in BOTH scope modes, mirroring
// desktop's `recentsProfile`: 'all' for the browse view, else the concrete profile
// key. Going through the aggregator (rather than listSessions, which is NOT
// profile-scoped) is what actually scopes the sidebar to the active profile, and
// it tags every row with its owning `profile` — which the lanes and ProfileTag
// need. `$sessionsLimit` stays global, so in browse mode a limit of N is split
// across profiles by recency; `resetSessionsPaging()` keeps a big browse-mode
// limit from leaking into a small single profile.
//
// This RELOADS the whole loaded window (offset 0, `$sessionsLimit` rows) rather
// than paging: it runs when the list may have changed underneath us, so every
// loaded row has to be re-read to stay correct. Paging deeper is
// `loadMoreSessions`, which appends a single offset-addressed page.
/**
 * How deep into the RECENCY WINDOW a page reached.
 *
 * Not `page.length`. Both list endpoints pass `include_pinned=True`, which
 * back-fills pinned conversations past the limit and APPENDS them after the
 * recency window — so a page of `limit` can carry more than `limit` rows, and
 * the extras are not window positions. Paging with the raw row count as the next
 * `offset` therefore skips one real conversation per back-filled pin, and they
 * are gone from the list entirely: never fetched, never rendered, no gap to see.
 *
 * Reported by SE-H, who fixed the sibling instance of this in `hermes.ts`
 * (`pageWindow`, MJXHRM-229): that one DISCARDED the appended pins, this one
 * MISCOUNTS them. Correct before and after that lands — today no pins are
 * appended and `min` is just the row count.
 */
function recencyDepth(page: readonly SessionInfo[] | undefined, limit: number): number {
  return Math.min(page?.length ?? 0, limit)
}

export async function refreshSessions(): Promise<void> {
  $sessionsLoading.set(true)

  const scope = $profileScope.get()
  const limit = $sessionsLimit.get()

  try {
    const res = await listAllProfileSessions(limit, 1, 'exclude', 'recent', scope === ALL_PROFILES ? 'all' : scope)

    // A refresh can race an in-flight delete/archive, and the page it returns
    // may predate it. Honouring the optimistic tombstones is what keeps the row
    // from flashing back; the ids the server DID return then lift the ones it
    // has caught up with.
    //
    // Through `reuseUnchanged` (MJXHRM-383): this response was JSON-parsed, so
    // every row is a fresh object even when nothing changed, and
    // `SidebarSessionRow`'s memo comparator bails only on
    // `Object.is(prev.session, next.session)`. Stored verbatim, a poll every
    // ~10s re-rendered every mounted row for nothing. Reusing the rows that did
    // not move is what lets the memo actually skip; an unchanged page comes back
    // as the SAME array, which nanostores does not even publish.
    $sessions.set(reuseUnchanged($sessions.get(), withoutTombstoned(res.sessions ?? [])))
    pruneSessionTombstones((res.sessions ?? []).map(session => session.id))
    $sessionsTotal.set(scope === ALL_PROFILES ? res.total : (res.profile_totals?.[scope] ?? res.total))
    // Bumped only on the success path, and only here: this says "a WHOLE window
    // just landed", which is the one moment a pin's absence from `$sessions`
    // carries information (the backend back-fills pinned rows past the limit,
    // so a live pin cannot miss a fresh page). `loadMoreSessions` appends a
    // deeper page and proves nothing about the head, and a failed fetch leaves
    // the list saying nothing at all. store/session-pin-sync.ts sweeps on it.
    $sessionsListEpoch.set($sessionsListEpoch.get() + 1)
  } catch (err) {
    // A list-fetch failure is not any one chat's status: surface it as a
    // notification instead of pinning it to whichever session is on screen.
    notifyError(err, 'Failed to load sessions')
  } finally {
    $sessionsLoading.set(false)
  }
}

/** Drop back to the first page — called when the profile scope changes, and when a
 *  soft gateway switch starts the list over. */
export function resetSessionsPaging(): void {
  $sessionsLimit.set(PAGE)
}

/**
 * Append the NEXT page — one `offset`-addressed fetch of `PAGE` rows, not a
 * re-fetch of the whole window. `$sessionsLimit` tracks how many rows are
 * loaded so a later `refreshSessions()` restores the same depth.
 *
 * Rows are de-duplicated by id: the list is ordered by recency, so a session
 * that gets a message between the two fetches shifts toward the head and can
 * appear in both pages. Without the guard it would render twice and React would
 * warn on the duplicate key.
 */
export async function loadMoreSessions(): Promise<void> {
  const loaded = $sessions.get()
  const scope = $profileScope.get()
  // The cursor is the recency DEPTH reached so far, not the number of rows on
  // screen: back-filled pins ride along in every page without occupying a
  // window position, so `loaded.length` overshoots by the pin count and each
  // page silently skips that many conversations.
  const offset = $sessionsLimit.get()

  $sessionsLoading.set(true)

  try {
    const res = await listAllProfileSessions(
      PAGE,
      1,
      'exclude',
      'recent',
      scope === ALL_PROFILES ? 'all' : scope,
      {},
      offset
    )

    // De-duplicated by id: the list is recency-ordered, so a session that gets a
    // message between the two fetches shifts toward the head and can appear in
    // both pages — and a back-filled pin appears in EVERY page by construction.
    const seen = new Set(loaded.map(session => session.id))
    const fresh = withoutTombstoned(res.sessions ?? []).filter(session => !seen.has(session.id))

    if (fresh.length) {
      $sessions.set([...loaded, ...fresh])
    }

    $sessionsLimit.set(offset + recencyDepth(res.sessions, PAGE))
    $sessionsTotal.set(scope === ALL_PROFILES ? res.total : (res.profile_totals?.[scope] ?? res.total))
  } catch (err) {
    notifyError(err, 'Failed to load sessions')
  } finally {
    $sessionsLoading.set(false)
  }
}

// Only the newest open may write chat state. Two async sources (the REST
// transcript + the resume RPC) mean a fast switch can land the SLOWER response
// of the chat you just left after the newer one already painted — desktop's
// `isCurrentResume` guard, in miniature.
let openGeneration = 0
const isCurrentOpen = (generation: number): boolean => generation === openGeneration

/**
 * Stored id → the generation of the `hydrateColdSession` currently filling its
 * `hydrating:<id>` placeholder.
 *
 * A box, not a number, so a re-open of the SAME session can hand the hydrate
 * already fetching it a NEWER generation instead of cancelling it. Cancelling it
 * is what stranded the placeholder: seeded `busy: true` with no runtime id, it
 * is written by nothing else, refused by the LRU (`session-states.ts` never
 * evicts a busy placeholder), and read as a running turn by every surface keyed
 * on the stored id — the sidebar row's status dot and its running arc above all
 * (MJXHRM-385).
 */
const hydrationsInFlight = new Map<string, { generation: number }>()

/**
 * Open a stored session.
 *
 * WARM sessions promote SYNCHRONOUSLY. A session that already has a slice — a
 * background bubble, an open tile, or one we simply haven't evicted — is made
 * active by moving the pointer, with no `session.resume`, no transcript clear,
 * and no await. That is what makes switching mid-turn lossless: the outgoing
 * session keeps its slice and keeps streaming into it, and the incoming one is
 * already whole.
 *
 * The old implementation cleared `$messages` and set `$busy` immediately but
 * bound the runtime id only AFTER awaiting REST + resume. In that window the
 * outgoing session's deltas still matched the active id, so they appended into
 * the transcript of the chat you had just switched to — and were then clobbered
 * by the resume payload, and lost from the session that produced them. That is
 * MJX-132.
 */
export interface OpenSessionOptions {
  /**
   * Re-issue `session.resume` even when the slice is warm.
   *
   * The warm short-circuit is a UI decision — the transcript is already whole,
   * so there is nothing to fetch. It is ALSO, incidentally, the thing that binds
   * the gateway TRANSPORT to this webview: each webview mints its own socket,
   * and the backend routes a session's events to whichever connection last
   * resumed it. So a window that legitimately has nothing to re-render can still
   * legitimately need to reclaim the stream — after a HUD window resumes a
   * session and closes, the main window's slice is warm and nothing ever asks
   * for the session back (MJXHRM-371).
   *
   * OPT-IN, never the default: resuming unconditionally on the warm path is
   * exactly the regression MJX-132 fixed.
   */
  forceResume?: boolean
}

export function openSession(storedId: string, options?: OpenSessionOptions): Promise<void> | void {
  const warm = runtimeKeyForStoredSession(storedId)

  if (warm && $sessionStates.get()[warm]) {
    // A HYDRATE STILL IN FLIGHT is not a warm session — it is this same open,
    // still running, and its slice is a placeholder with no runtime binding.
    // Re-arm it rather than bumping past it: the generation counter is the
    // CANCEL signal, and cancelling the hydrate that is about to bind this
    // session leaves it busy forever (see `hydrationsInFlight`). One sidebar row
    // clicked twice was enough — `onResumeSession` calls this on every click,
    // with no already-active guard.
    const hydrating = warm === hydratingKey(storedId) ? hydrationsInFlight.get(storedId) : undefined

    if (hydrating) {
      hydrating.generation = ++openGeneration
      resetUnscopedStreamPin()
      $activeStoredSessionId.set(storedId)
      $activeSessionKey.set(warm)

      return undefined
    }

    openGeneration++ // cancel any hydrate still in flight
    resetUnscopedStreamPin()
    $activeStoredSessionId.set(storedId)
    $activeSessionKey.set(warm)

    return options?.forceResume ? reclaimWarmSession(storedId, warm) : undefined
  }

  return hydrateColdSession(storedId)
}

/**
 * Resume a session whose slice is already warm — a TRANSPORT-only rebind.
 *
 * Deliberately not a hydrate: no transcript fetch, no message replacement, no
 * `busy` write. The slice is correct and may be mid-turn; the only thing being
 * reclaimed is which connection the gateway routes this session's events to.
 * Writing the resume payload's messages here would reintroduce MJX-132 through
 * the back door, since that history is display-REDUCED (see the AUTHORITY note
 * on `hydrateColdSession`) and would overwrite a richer transcript with it.
 *
 * The runtime id is re-keyed only when the backend hands back a different one —
 * a compaction while another window held the session — and `rekeySession` moves
 * the slice wholesale, so its messages and in-flight turn ride across unchanged.
 */
async function reclaimWarmSession(
  storedId: string,
  warmKey: string,
  options?: { /** Whether this reclaim is also making the session ACTIVE. */ activate?: boolean }
): Promise<void> {
  // A reclaim that is NOT promoting the session (`reclaimSessionTransport`) must
  // not be cancelled by an unrelated open: the generation counter answers "is
  // this still the chat the user is switching to", and a background rebind is
  // not answering that question. Cancelling it there would be the silent no-op
  // this whole seam exists to avoid.
  const activate = options?.activate ?? true
  const generation = openGeneration
  const stillWanted = () => !activate || isCurrentOpen(generation)

  const known = knownSessionProfile(storedId)
  const profile = known ?? (sessionProfileIsAmbiguous() ? await resolveSessionProfile(storedId) : undefined)

  if (!stillWanted()) {
    return
  }

  try {
    const resumed = await requestGateway<SessionResumeResponse>('session.resume', {
      session_id: storedId,
      cols: 96,
      ...(profile ? { profile } : {})
    })

    if (!stillWanted() || (resumed.session_id ?? storedId) === warmKey) {
      return
    }

    // The slice can be gone by now — deleted, evicted, or re-keyed by a hydrate
    // that raced us. `rekeySession` would happily move an EMPTY state onto the
    // new runtime id and leave a ghost session behind, so check first.
    if (!$sessionStates.get()[warmKey]) {
      return
    }

    const runtimeId = resumed.session_id ?? storedId

    rekeySession(warmKey, runtimeId, {
      runtimeSessionId: runtimeId,
      storedSessionId: storedId,
      ...(resumed.info?.cwd ? { cwd: resumed.info.cwd } : {})
    })

    // Only when this session IS the active one. A background reclaim that moved
    // the active key would point the chat pane at a conversation the user is not
    // looking at.
    if ($activeSessionKey.get() === warmKey) {
      $activeSessionKey.set(runtimeId)
    }
  } catch (err) {
    // The chat on screen is intact and still readable — only the stream binding
    // failed — so this is a notification rather than a status-line error that
    // would stick to a session which is otherwise fine.
    notifyError(err, 'Failed to reconnect session')
  }
}

/**
 * Rebind a session's gateway stream onto THIS webview without touching what the
 * window is showing (MJXHRM-371).
 *
 * The counterpart to `openSession(id, { forceResume: true })`, for the case where
 * the session must be reclaimed but the user is looking at something else: a
 * pop-out window (a detached tile, or "open chat in a new window") took the
 * binding for a session that is ALSO open here — as a tile, or simply parked —
 * and has now closed. The tile reappears in its slot looking perfectly healthy
 * and receives nothing, because the slice is warm and nothing ever asks for the
 * session back. See `store/popout-transport.ts`.
 *
 * A no-op unless the session has a real live slice here:
 *
 * - no slice at all — nothing on screen is deaf, and the next `openSession` will
 *   hydrate it cold, which resumes and binds properly. That is the whole check:
 *   `runtimeKeyForStoredSession` answers null for a stale index entry too, so
 *   re-testing `$sessionStates` here would be a branch nothing could reach;
 * - a PLACEHOLDER key — a hydrate is already in flight and will issue its own
 *   resume; forcing a second one would race its re-key and strand the slice.
 */
export async function reclaimSessionTransport(storedId: string): Promise<void> {
  const warm = runtimeKeyForStoredSession(storedId)

  if (!warm || isPlaceholderKey(warm)) {
    return
  }

  await reclaimWarmSession(storedId, warm, { activate: false })
}

/**
 * Hydrate a session that has no live slice: transcript + runtime binding.
 *
 * AUTHORITY: the transcript comes from the REST endpoint
 * (`GET /api/sessions/{id}/messages` → `db.get_messages`), NOT from the resume
 * RPC. `session.resume` returns a display-REDUCED history
 * (`_history_to_messages` in tui_gateway/server.py): assistant rows that only
 * made tool calls are dropped outright — taking that step's reasoning with them
 * — and each tool result is flattened to `{role, name, context}` with no
 * `tool_call_id` and no output. Hydrating from it lost every intermediate
 * thinking block and collapsed repeated same-name tool calls into one row.
 * The resume payload is still what binds the runtime id, the cwd, and the
 * in-flight turn; its messages are only a fallback when REST is unavailable.
 */
async function hydrateColdSession(storedId: string): Promise<void> {
  // Boxed so `openSession` can re-arm THIS hydrate when the same session is
  // opened again while it runs (see `hydrationsInFlight`).
  const own = { generation: ++openGeneration }
  hydrationsInFlight.set(storedId, own)
  resetUnscopedStreamPin()

  // The session gets its slice up front, under a placeholder key, so the UI has
  // something of its own to render immediately instead of a blank chat that a
  // later response overwrites.
  //
  // Each stored session carries the project directory it runs in. Restore it
  // from the list row so the statusbar / file tree switch with the chat
  // immediately; the resume response's runtime info supersedes it below with the
  // authoritative value. (A cwd-less row settles to '' — a detached chat — which
  // is the correct final state, not a flicker; the files-tree white flash is
  // handled where it belongs, in use-project-tree.)
  let key = hydratingKey(storedId)

  ensureSessionSlice(key, {
    storedSessionId: storedId,
    busy: true,
    cwd: $sessions.get().find(session => session.id === storedId)?.cwd ?? ''
  })

  $activeStoredSessionId.set(storedId)
  $activeSessionKey.set(key)

  // A session resumed MID-TURN stays busy: the committed transcript ends before
  // the running turn, and `inflight` carries its tail. Settle to idle otherwise.
  let stillRunning = false

  /**
   * This open was superseded. The placeholder it seeded is `busy: true` with no
   * runtime binding, so it cannot be left in place: nothing else writes it, the
   * LRU refuses to evict a busy placeholder, and a later `openSession` would
   * short-circuit onto a slice that can neither stream nor submit. Re-opening
   * hydrates from scratch, which is the only way to get a bound session anyway.
   *
   * Never touches a slice that already reached its runtime id — by then it is a
   * real session that happens to have lost the race for the foreground.
   */
  const abandonPlaceholder = () => {
    if (!isPlaceholderKey(key)) {
      return
    }

    if ($activeSessionKey.get() === key) {
      // Unreachable while `openSession` re-arms an in-flight hydrate instead of
      // cancelling it — but a chat yanked out from under the user is the worse
      // failure of the two, so settle the slice rather than drop it. Its stored
      // id IS the active one here, so this cannot raise a false "your turn".
      updateSession(key, state => ({ ...state, busy: false }))

      return
    }

    dropSessionState(key)
  }

  // Resolve the OWNING profile before either call. A session can be opened from
  // any profile — a search hit, a restored tile, a deep link — and a resume or a
  // transcript read without one lands on whichever gateway is live, forking the
  // conversation into the wrong profile's database.
  //
  // Both fast paths are SYNCHRONOUS on purpose: a loaded row carries its own
  // stamp, and a single-profile install has nothing to route. Only a genuine
  // miss on a multi-profile install awaits a probe — otherwise the resume would
  // be deferred a microtask on every single open, which is long enough for a
  // second open to overtake it.
  const known = knownSessionProfile(storedId)
  const profile = known ?? (sessionProfileIsAmbiguous() ? await resolveSessionProfile(storedId) : undefined)

  if (!isCurrentOpen(own.generation)) {
    abandonPlaceholder()
    releaseHydration(storedId, own)

    return
  }

  // The REST transcript and the resume RPC are independent, so run them
  // concurrently (desktop does the same): wall time is max(), not sum, and the
  // transcript paints as soon as it lands instead of waiting on the agent build.
  // `.then(...)` rather than a bare call so a synchronous throw inside the REST
  // client can't take the resume down with it.
  const transcriptPromise = Promise.resolve()
    .then(() => getSessionMessages(storedId, profile))
    .catch(() => null)

  const resumePromise = requestGateway<SessionResumeResponse>('session.resume', {
    session_id: storedId,
    cols: 96,
    ...(profile ? { profile } : {})
  })

  // The rejection is consumed by the `await` below; this only keeps it from
  // surfacing as an unhandled rejection while the transcript fetch settles.
  resumePromise.catch(() => undefined)

  try {
    const transcript = await transcriptPromise
    const hydrated = transcript?.messages?.length ? toChatMessages(transcript.messages) : []
    // Only treat REST as the authority when it actually yielded a transcript —
    // an empty result falls through to the resume payload rather than painting
    // an empty chat.
    const restMessages = hydrated.length ? hydrated : null

    if (restMessages && isCurrentOpen(own.generation)) {
      updateSession(key, state => ({ ...state, messages: restMessages }))
    }

    const resumed = await resumePromise

    if (!isCurrentOpen(own.generation)) {
      abandonPlaceholder()

      return
    }

    const runtimeId = resumed.session_id ?? storedId

    // Project the still-running turn onto the committed transcript, so its
    // pending assistant exists for the live reducer to keep filling — otherwise
    // the turn's remaining tool events land in a fresh bubble that never settles.
    // The REST transcript is the authority when we have it (see AUTHORITY note).
    const messages = appendLiveSessionProjection(restMessages ?? toChatMessages(resumed.messages ?? []), resumed)

    stillRunning = resumedTurnIsLive(resumed)

    // SYNCHRONOUS, before any further await: the router drops events for unknown
    // keys, so the slice has to exist under its real runtime id before the first
    // streamed event for it is processed. JS drains microtasks before the next
    // websocket message task, so this ordering holds.
    rekeySession(key, runtimeId, {
      runtimeSessionId: runtimeId,
      storedSessionId: storedId,
      messages,
      busy: stillRunning,
      ...(resumed.info?.cwd ? { cwd: resumed.info.cwd } : {})
    })

    key = runtimeId

    // A session resumed MID-TURN — or one the gateway just scheduled a crash
    // continuation for — is running a turn this process never opened. Adopting
    // it is what puts the chat into `$inflightTurns`, and therefore into the set
    // `reconcileInflightTurns` walks on every WS re-open; the tile delegate has
    // done this since MJXHRM-356, the primary chat never did, so the surface
    // most likely to be holding a live turn was the one invisible to reconnect
    // reconciliation. After the rekey, so the record lands under the key the
    // router addresses.
    adoptResumedTurn(runtimeId, resumed)
  } catch (err) {
    if (!isCurrentOpen(own.generation)) {
      abandonPlaceholder()

      return
    }

    // The resume RPC failed. Fall back to the REST transcript alone (already
    // painted above when it resolved) so the chat at least shows its history,
    // with no live runtime binding.
    const transcript = await transcriptPromise

    if (transcript) {
      rekeySession(key, storedId, {
        runtimeSessionId: storedId,
        storedSessionId: storedId,
        messages: toChatMessages(transcript.messages ?? [])
      })
      key = storedId
    } else {
      // Not the session's own status: surface it as a notification rather than
      // wedging a load error into this chat's status line, where it would stick.
      notifyError(err, 'Failed to open session')
    }
  } finally {
    releaseHydration(storedId, own)

    if (isCurrentOpen(own.generation)) {
      updateSession(key, state => ({ ...state, busy: stillRunning }))
    }
  }
}

/** Forget a finished hydrate — but only if it is still the one on record. An
 *  abandoned hydrate can outlive the fresh one that replaced it, and clearing
 *  the map blindly would make the live hydrate look cancellable again. */
function releaseHydration(storedId: string, own: { generation: number }): void {
  if (hydrationsInFlight.get(storedId) === own) {
    hydrationsInFlight.delete(storedId)
  }
}

export function newSession(cwd?: string): void {
  resetChat(cwd)
  $activeStoredSessionId.set(null)
  flashPetActivity({ greeting: true }) // pet: wave hello on a fresh chat
}

/**
 * Open a fresh chat anchored to a specific directory — desktop's
 * `startWorkspaceSession`, reduced to what universal needs. Used by the
 * composer's "start work" / branch-off hand-off, where a worktree was just
 * created and the next session must run inside it rather than in the configured
 * default project dir.
 *
 * The anchor is the new DRAFT'S OWN slice cwd, seeded as part of the reset
 * rather than written over it afterwards. Resetting first and correcting second
 * publishes the directory in between — the configured default, or '' when there
 * is none, which sends `$effectiveCwd` to the backend workspace root. The
 * composer hand-off hides that: it runs inside a `$startWorkSessionRequest`
 * listener, where nanostores coalesces nested writes. The SIDEBAR's "start work"
 * calls straight from a click handler (sidebar-content `newSessionInWorkspace`),
 * so there the intermediate reached every subscriber and the statusbar path and
 * file tree flipped to it until the first prompt re-notified them.
 *
 * `ensureSession` reads the anchor back on that first prompt. Per-session by
 * construction: a second draft — a mobile bubble, another tab — carries its own
 * directory and can't inherit this one.
 */
export function startSessionInWorkspace(path: string): void {
  newSession(path.trim() || undefined)
}

/**
 * Optimistically add a just-created session to the sidebar list + mark it active,
 * seeding the row's PREVIEW with the user's first message so `sessionTitle`
 * (title || preview || 'Untitled') shows it immediately — instead of the chat
 * being absent from the list and the header stuck on "New session". The backend's
 * async `session.title` event later patches `title` in place (see store/chat.ts),
 * superseding the first-message preview. Desktop parity (upsertOptimisticSession).
 */
export function registerNewSession(id: string, firstMessage: string, cwd?: string, profile?: string): void {
  insertOptimisticSession(id, firstMessage, cwd, profile)
  $activeStoredSessionId.set(id)
}

/** The row half of `registerNewSession`, without claiming the main pane — a
 *  branch opened in its own TAB must appear in the sidebar without taking the
 *  chat you branched FROM off the screen.
 *
 *  `cwd` overrides the open chat's directory. It has to, for a branch: the row
 *  belongs to the session that was BRANCHED, which is not necessarily the one
 *  on screen, and the sidebar lane and inherited colour are both derived from
 *  this field (MJXHRM-386). Left out, the branch of a background session was
 *  filed under whatever project the foreground chat was in, and wore its
 *  colour, until the next list refresh corrected it.
 *
 *  `profile` is on the STUB rather than patched in afterwards because
 *  `registerNewSession` publishes the id the moment the row exists, and the
 *  `$activeStoredSessionId` subscriber reads the row's owner right then to
 *  remember this profile's place (`$lastSessionByProfile`). A row that gains
 *  its profile one statement later is read as unowned, and the branch was
 *  remembered against whichever gateway happened to be live — the same
 *  cross-profile bleed the branch's own `profile` exists to close
 *  (MJXHRM-388). */
function insertOptimisticSession(id: string, firstMessage: string, cwd?: string, profile?: string): void {
  const now = Math.floor(Date.now() / 1000)

  const stub: SessionInfo = {
    // Seed the row's project directory (ensureSession just adopted the runtime's
    // resolved cwd) so re-opening this chat later restores the same directory,
    // and the sidebar can group it by workspace right away.
    cwd: (cwd ?? $currentCwd.get()).trim() || null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: true,
    last_active: now,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: firstMessage.trim().slice(0, 200) || null,
    ...(profile ? { profile } : {}),
    source: null,
    started_at: now,
    title: null,
    tool_call_count: 0
  }

  $sessions.set([stub, ...$sessions.get().filter(s => s.id !== id)])
}

/**
 * WHERE A BRANCH OF THE OPEN CHAT LANDS.
 *
 * A registered hook rather than a direct call, because placement lives in
 * `store/session-states` (a tile) and `store/chat-bubbles` (a bubble) and BOTH
 * import this module — calling either from here is an import cycle. It follows
 * the same shape as `setVisibleBubbleKeysProvider`: the surface that knows the
 * platform registers the behaviour, and `app/contrib/controller` is that place.
 *
 * The PARENT rides along: a branch belongs in the tab strip its parent is in,
 * which on this platform is not necessarily the main one — branching a chat
 * that is itself a tile in a side zone put the branch in the workspace strip,
 * i.e. somewhere the user was not looking.
 */
let openBranchedSession: ((storedSessionId: string, parentStoredId: null | string) => void) | null = null

export function setBranchedSessionOpener(
  open: null | ((storedSessionId: string, parentStoredId: null | string) => void)
): void {
  openBranchedSession = open
}

/** The copyable spine of a branch: user/assistant turns that carry text.
 *  Ported from desktop's use-session-actions/utils.ts `toBranchMessages`. */
function toBranchMessages(
  messages: ChatMessage[]
): { content: string; role: ChatMessage['role']; source: ChatMessage }[] {
  return messages
    .map(message => ({ content: chatMessageText(message), role: message.role, source: message }))
    .filter(({ content, role }) => content.trim() && (role === 'assistant' || role === 'user'))
}

/**
 * The chat a branch is taken FROM — the four things `branchCurrentSession`
 * reads off it, passed in rather than read from the primary atoms.
 *
 * Universal renders N chats at once (tiles, mobile bubbles), and every other
 * per-surface action already routes by the surface's own `SessionView`:
 * `use-slash-command` says so in as many words ("the surface's own, never the
 * foreground one"). Branching was the one that did not, and it was worse than
 * a no-op — hydrated transcript ids are POSITIONAL (`h3-assistant`, see
 * `lib/session-history`), so "branch in new chat" on a tile's fourth message
 * found the main chat's fourth message and forked THAT conversation, silently
 * and with no error to notice (MJXHRM-388).
 */
export interface BranchSource {
  busy: boolean
  cwd: string
  messages: ChatMessage[]
  /** The WIRE session id, null on a draft that has never been created — the
   *  slice key is not it (a hydrating slice has a placeholder key). */
  runtimeId: null | string
  storedId: null | string
}

/** The primary chat, for callers with no surface of their own. */
function primaryBranchSource(): BranchSource {
  return {
    busy: $busy.get(),
    cwd: $currentCwd.get(),
    messages: $messages.get(),
    runtimeId: $sessionId.get(),
    storedId: $activeStoredSessionId.get()
  }
}

/**
 * Fork a chat off its live transcript — `/branch` (aliases `/fork`) and the
 * assistant message's "branch in new chat". Ported from desktop's
 * `branchCurrentSession` + `forkBranch`: the copied turns are handed to
 * `session.create`, so the new chat opens pre-seeded instead of empty. Without
 * `messageId` it forks from the last user/assistant turn.
 *
 * `from` names the chat being branched; omitted, it is the primary one.
 */
export async function branchCurrentSession(messageId?: string, from?: BranchSource): Promise<boolean> {
  const source = from ?? primaryBranchSource()

  if (!source.runtimeId) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.nothingToBranch'),
      message: translateNow('desktop.branchNeedsChat')
    })

    return false
  }

  if (source.busy) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.sessionBusy'),
      message: translateNow('desktop.branchStopCurrent')
    })

    return false
  }

  const messages = source.messages

  // findLastIndex is ES2023; this project's lib target predates it, so scan back.
  const lastTurnIndex = (): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const role = messages[index].role

      if (role === 'assistant' || role === 'user') {
        return index
      }
    }

    return -1
  }

  const at = messageId ? messages.findIndex(message => message.id === messageId) : lastTurnIndex()

  // An explicit target that can't be resolved must NOT silently degrade into
  // "branch the last turn" — that forks the wrong conversation. (This is what
  // the missing id passthrough in app/chat/runtime.tsx used to cause.)
  if (messageId && at < 0) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.nothingToBranch'),
      message: translateNow('desktop.branchNoText')
    })

    return false
  }

  // Everything UP TO the chosen turn, not the turn on its own. A branch is a
  // conversation that shares a past with its parent and diverges from there;
  // seeded with the single clicked message it is a new chat quoting one reply,
  // with the question it answered — and every turn before it — gone. Desktop
  // slices from 0 for this reason and its test says so ("only the clicked
  // message survived instead of everything up to it"); the port narrowed it to
  // `[at, at + 1)` and re-opened the bug on this platform (MJXHRM-388).
  const end = at >= 0 ? at + 1 : messages.length
  const branchMessages = toBranchMessages(messages.slice(0, end))

  if (!branchMessages.length) {
    notify({
      kind: 'warning',
      title: translateNow('desktop.nothingToBranch'),
      message: translateNow('desktop.branchNoText')
    })

    return false
  }

  // The row's LIVE tip, not the id the surface is holding. A tile's stored id is
  // captured when the tile opens and never moves, so a session that has since
  // rotated through a compression would nest its branch under a dead id — the
  // same wide, alias-aware lookup `branchStoredSession` takes (MJXHRM-386), for
  // the same reason. Dynamic because `store/session-lookup` reads `$projectTree`
  // and `store/projects` already imports this module.
  const { sessionRowFor } = await import('@/store/session-lookup')
  const parentStoredId = source.storedId ? (sessionRowFor(source.storedId)?.id ?? source.storedId) : null

  // The BRANCHED chat's owning profile, not the launch/picker one (MJXHRM-388).
  // Every other mutation path resolves this; `branchCurrentSession` was the one
  // that did not, so `session.create` landed the branch on whichever gateway
  // happened to be live — the "my session jumped to another profile after
  // branching" bug, described in `ForkBranchOptions.profile` and guarded against
  // everywhere except here.
  const profile = parentStoredId ? await resolveSessionProfile(parentStoredId) : undefined

  const storedId = await forkBranchSession({
    branchMessages,
    cwd: source.cwd.trim(),
    // A branch opens BESIDE the chat it came from, not on top of it — `true`
    // would claim the main pane and push the parent off screen, which is the
    // one chat the user is certainly still interested in. `false` + the opener
    // below is what "branch in a new chat" has always meant on desktop.
    //
    // With no opener registered (a secondary window, a test) the branch takes
    // main after all: unreachable is worse than displacing.
    foreground: openBranchedSession === null,
    parentStoredId,
    profile
  })

  if (storedId !== null) {
    openBranchedSession?.(storedId, parentStoredId)
  }

  return storedId !== null
}

type BranchMessage = { content: string; role: ChatMessage['role']; source: ChatMessage }

interface ForkBranchOptions {
  branchMessages: BranchMessage[]
  cwd: string
  /** Whether the branch takes over the MAIN pane. A branch made from a session's
   *  tab opens in its own tab instead, so the chat you branched from stays put. */
  foreground: boolean
  parentStoredId: null | string
  /** The profile that owns the PARENT. A branch belongs to its parent's
   *  database; omitted, `session.create` lands it on whichever gateway is live —
   *  the "the session jumped to another profile after branching" bug. */
  profile?: string
}

/**
 * Create the branch session and seed it locally. Shared by branching the OPEN
 * chat (`branchCurrentSession`) and branching any listed one
 * (`branchStoredSession`); returns the new stored id, or null on failure.
 */
async function forkBranchSession({
  branchMessages,
  cwd,
  foreground,
  parentStoredId,
  profile
}: ForkBranchOptions): Promise<null | string> {
  try {
    // No `title`. It is the gateway's `session.branch` that names a branch from
    // its parent's lineage (`get_next_title_in_lineage`); `session.create` has
    // no such rule, and `set_session_title` REJECTS a title already in use, so
    // shipping our own generic "branch N" would take for the first branch and
    // be dropped for the next parent's. The row is auto-titled from its first
    // turn like any other chat; the label below is the local placeholder until
    // then (desktop's `branchStoredSession` behaves identically).
    const branched = await requestGateway<SessionCreateResponse>('session.create', {
      cols: 96,
      ...(cwd && { cwd }),
      ...(profile ? { profile } : {}),
      messages: branchMessages.map(({ content, role }) => ({ content, role })),
      ...(parentStoredId && { parent_session_id: parentStoredId })
    })

    const storedId = branched.stored_session_id ?? branched.session_id
    const rows = $sessions.get()

    const siblings = parentStoredId
      ? rows.filter(session => session.parent_session_id?.trim() === parentStoredId).length
      : 0

    // The branch is a NEW session, so it gets its own slice keyed by its runtime
    // id — it does not overwrite the parent's, which stays open behind it.
    // Paint the copied turns locally rather than re-fetching: the branch has no
    // committed transcript until its first real message lands.
    ensureSessionSlice(branched.session_id, {
      runtimeSessionId: branched.session_id,
      storedSessionId: storedId,
      messages: branchMessages.map(({ source }) => source),
      busy: false,
      cwd: (branched.info?.cwd ?? cwd ?? '').trim(),
      sessionStartedAt: Date.now()
    })

    const preview = branchMessages.map(({ content }) => content).find(Boolean) ?? ''
    // The BRANCH's directory — the backend's resolved one, else the parent's —
    // not the open chat's. A branch made from a background session's tab (which
    // is where `foreground: false` comes from) would otherwise be filed under
    // the foreground chat's project, wearing its colour (MJXHRM-386).
    const branchCwd = (branched.info?.cwd ?? cwd ?? '').trim()

    // The branch is created ON the parent's profile, so its row is owned by that
    // profile too — otherwise the first refresh that scopes the sidebar drops it.
    // Seeded with the row rather than patched on after, so the id is never
    // published as unowned (see `insertOptimisticSession`).
    if (foreground) {
      $activeSessionKey.set(branched.session_id)
      registerNewSession(storedId, preview, branchCwd, profile)
    } else {
      insertOptimisticSession(storedId, preview, branchCwd, profile)
    }

    setSessions(prev =>
      prev.map(session =>
        session.id === storedId
          ? {
              ...session,
              parent_session_id: parentStoredId ?? null,
              title: translateNow('desktop.branchTitle', siblings + 1).toLowerCase()
            }
          : session
      )
    )

    return storedId
  } catch (err) {
    notifyError(err, translateNow('desktop.branchFailed'))

    return null
  }
}

/**
 * Branch ANY listed session, not just the open one — the session tab / sidebar
 * row's "Branch" verb.
 *
 * Reads the target's STORED transcript directly, so it needs neither a resume
 * nor the session to be active, and it runs on the parent's OWNING profile
 * throughout: the transcript read and the create both carry it, so a branch made
 * from another profile's tab lands in that profile's database and nests under
 * its real parent instead of appearing as an orphan on the live one.
 *
 * Returns the new branch's stored id so the caller can decide where it opens.
 */
export async function branchStoredSession(storedSessionId: string): Promise<null | string> {
  const profile = await resolveSessionProfile(storedSessionId)
  // The WIDE lookup (MJXHRM-386). This branches a session the user is NOT
  // looking at — a tile tab, the Command Center — which is exactly the sort
  // that has aged out of the paginated recents page. A miss handed
  // `session.create` an EMPTY cwd, so the branch was created in the gateway's
  // default directory instead of its parent's: it inherited no project, and
  // therefore no lane and no colour. `parent_session_id` also fell back to the
  // caller's possibly pre-rotation id rather than the row's live tip.
  //
  // Dynamic, because `store/session-lookup` reads `$projectTree` and
  // `store/projects` already imports this module — the same reason
  // `event-router` imports this one lazily. Safe here: the function is async
  // and only ever runs long after every module has initialized.
  const { sessionRowFor } = await import('@/store/session-lookup')
  const stored = sessionRowFor(storedSessionId)

  try {
    const transcript = await getSessionMessages(storedSessionId, profile)
    const branchMessages = toBranchMessages(toChatMessages(transcript.messages ?? []))

    if (!branchMessages.length) {
      notify({
        kind: 'warning',
        title: translateNow('desktop.nothingToBranch'),
        message: translateNow('desktop.branchNoText')
      })

      return null
    }

    return await forkBranchSession({
      branchMessages,
      cwd: stored?.cwd?.trim() ?? '',
      foreground: false,
      parentStoredId: stored?.id ?? storedSessionId,
      profile
    })
  } catch (err) {
    notifyError(err, translateNow('desktop.branchFailed'))

    return null
  }
}

/**
 * `/resume` (and the composer completion's "Browse all…" row) opens desktop's
 * dedicated session-picker overlay. Universal's equivalent surface is the
 * Command Center's `sessions` section, so route there instead of shipping a
 * second picker. Closing is the overlay's own job (Esc / backdrop), so `false`
 * is a no-op here.
 */
export function setSessionPickerOpen(open: boolean): void {
  if (open) {
    openAppRoute(`${COMMAND_CENTER_ROUTE}?section=sessions`)
  }
}

/**
 * Per-session YOLO (approval bypass) state, mirrored from the `config.set`
 * round-trip in lib/yolo-session.ts so the `/yolo` handler can toggle it.
 */
export const $yoloActive = atom(false)

export const setYoloActive = (active: boolean): void => $yoloActive.set(active)

/**
 * Rename a stored session.
 *
 * `id` is whatever the calling surface holds, which for a tile tab, a mobile
 * bubble or a restored layout pane is the id the chat was OPENED with — the
 * lineage ROOT once auto-compression has rotated it. `PATCH /api/sessions/{id}`
 * routes `title` to `set_session_title`, which writes a SINGLE row (unlike the
 * `pinned` / `archived` fields beside it, which flip the whole compression
 * chain), while the session list surfaces the TIP's title. Renaming under the
 * root wrote the new name onto a hidden ancestor: the dialog closed, the
 * "Renamed" toast fired, and the title never moved (MJXHRM-423).
 *
 * Both the optimistic patch and the wire call therefore go to the row's LIVE
 * id — the same thing the sidebar row and the title bar do by hand, which is
 * why neither of them ever showed this.
 *
 * Dynamic import for the same reason `branchStoredSession` uses one:
 * `store/session-lookup` reads `$projectTree` and `store/projects` already
 * imports this module. Safe here — this only ever runs long after every module
 * has initialized.
 */
export async function renameSessionLocal(id: string, title: string): Promise<void> {
  const { liveSessionIdFor } = await import('@/store/session-lookup')
  const target = liveSessionIdFor(id)
  const prev = $sessions.get()

  $sessions.set(prev.map(s => (s.id === target ? { ...s, title } : s)))

  try {
    await renameSession(target, title, knownSessionProfile(target))
  } catch (err) {
    $sessions.set(prev)
    notifyError(err, 'Rename failed')
  }
}

/** The ids a removal has to evict. A pin — and the backend's own row — can be
 *  keyed on the durable lineage root rather than the live tip after a
 *  compression, so both have to fall or the row comes back under the other id. */
function removalIds(session: SessionInfo | undefined, id: string): string[] {
  return sessionAliasIds(id, session)
}

/** Does `candidate` name the conversation these alias ids belong to? The
 *  "is this the session in main?" check, asked so a removal driven from a
 *  surface holding a different alias still empties the pane. */
function idNamesSession(ids: readonly string[], candidate: null | string): boolean {
  return Boolean(candidate) && ids.includes(candidate as string)
}

export async function deleteSessionLocal(id: string): Promise<void> {
  const prev = $sessions.get()
  const removed = prev.find(s => sessionMatchesStoredId(s, id))
  const ids = removalIds(removed, id)
  // Read the owner BEFORE the optimistic removal — afterwards the row that
  // carries the stamp is gone and the mutation would go out unscoped.
  const owner = knownSessionProfile(id)

  // DELETING UNPINS (MJXHRM-414). Nothing else ever dropped the pin, and the
  // Pinned section falls back to `$pinnedSessionCache` once the row leaves
  // `$sessions` — which is exactly the state a delete leaves behind. So a
  // deleted session stayed pinned forever, as a row nothing could resolve.
  // Pins are keyed on the DURABLE lineage root while the id passed here may be
  // the live tip after a compression, so both have to fall.
  const previousPinned = $pinnedSessionIds.get()
  const removedPinId = removed ? sessionPinId(removed) : id

  $pinnedSessionIds.set(previousPinned.filter(pinId => pinId !== id && pinId !== removedPinId))

  // By ALIAS, not `s.id !== id`. The backend already drops the whole compression
  // chain (`include_compression_lineage=True`), and `removalIds` already
  // tombstones every id — but the optimistic removal matched on the live tip
  // alone, so a delete arriving from a surface that holds the lineage root (a
  // tile tab, a bubble) left the row sitting in the sidebar until the next
  // fetch. Same rule the `removed` lookup two lines up already uses.
  $sessions.set(prev.filter(s => !sessionMatchesStoredId(s, id)))
  $sessionsTotal.set(Math.max(0, $sessionsTotal.get() - 1))
  // Pin the tombstone for as long as the RPC is in flight, so a list or project
  // tree refresh that predates it can't flash the row back.
  tombstoneSessions(ids)
  markSessionMutation(ids, true)

  // `ids` (every alias of the removed conversation), not `=== id`: main can be
  // holding the live tip while the delete comes from a tile tab holding the
  // root. Left on identity, main went on rendering a conversation the backend
  // had just deleted, and the next submit into it would 404.
  if (idNamesSession(ids, $activeStoredSessionId.get())) {
    newSession()
  }

  try {
    await deleteSession(id, owner)
  } catch (err) {
    $sessions.set(prev)
    $sessionsTotal.set($sessionsTotal.get() + 1)
    $pinnedSessionIds.set(previousPinned)
    untombstoneSessions(ids)
    notifyError(err, 'Delete failed')
  } finally {
    // Released, not lifted: the tombstone now prunes normally, once the backend
    // stops listing the id.
    markSessionMutation(ids, false)
  }
}

export async function archiveSessionLocal(id: string): Promise<void> {
  const prev = $sessions.get()
  const archived = prev.find(s => sessionMatchesStoredId(s, id))
  const ids = removalIds(archived, id)
  const owner = knownSessionProfile(id)

  // By ALIAS — see the same edit in `deleteSessionLocal`. `set_session_archived`
  // flips the whole compression chain on the backend, so the row is gone there
  // either way; matching on the tip alone just meant the sidebar disagreed with
  // it until the next fetch.
  $sessions.set(prev.filter(s => !sessionMatchesStoredId(s, id)))
  tombstoneSessions(ids)
  markSessionMutation(ids, true)

  if (idNamesSession(ids, $activeStoredSessionId.get())) {
    newSession()
  }

  try {
    await setSessionArchived(id, true, owner)
  } catch (err) {
    $sessions.set(prev)
    untombstoneSessions(ids)
    notifyError(err, 'Archive failed')
  } finally {
    markSessionMutation(ids, false)
  }
}

export async function searchSessionsQuery(query: string): Promise<void> {
  const q = query.trim()

  if (!q) {
    $sessionSearch.set([])

    return
  }

  $searchLoading.set(true)

  try {
    const res = await searchSessions(q)
    $sessionSearch.set(res.results ?? [])
  } catch {
    $sessionSearch.set([])
  } finally {
    $searchLoading.set(false)
  }
}
