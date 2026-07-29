/**
 * The per-session state record + its shared atom — a LEAF module so every layer
 * (`store/chat.ts`, `store/session.ts`, `store/session-states.ts`,
 * `store/session-reducer.ts`) can read `$sessionStates` without an import cycle.
 * The type imports are erased at build, so this file has no runtime deps beyond
 * nanostores.
 *
 * `$sessionStates` is THE source of truth for EVERY session — the one on screen,
 * the ones in tiles, and the ones behind mobile bubbles. There is no separate
 * "primary" storage: the active chat is simply the slice `$activeSessionKey`
 * points at, and `store/chat.ts`'s `$messages`/`$busy`/… are computed
 * projections of it. That is what makes a background session's tokens land in
 * its own slice structurally, rather than by a guard that can fail open.
 *
 * (This inverts the earlier universal design, where the primary chat lived in
 * global atoms and `$sessionStates` held tiles only — see MJX-132.)
 */

import { atom } from 'nanostores'

import type { ChatMessage } from '@/lib/chat-messages'
import { flushDeltas } from '@/lib/stream-batch'
import type { UsageStats } from '@/types/hermes'

/** The full client-side state of ONE session — the unit a chat surface renders
 *  from and the reducer writes per session key. Ported from desktop `app/types.ts`. */
export interface ClientSessionState {
  /** The gateway's LIVE session id, or null for a draft that has never been
   *  created. This is the only value safe to send as `session_id` on the wire. */
  runtimeSessionId: null | string
  storedSessionId: string | null
  messages: ChatMessage[]
  branch: string
  cwd: string
  model: string
  provider: string
  reasoningEffort: string
  serviceTier: string
  fast: boolean
  yolo: boolean
  personality: string
  busy: boolean
  awaitingResponse: boolean
  streamId: string | null
  sawAssistantPayload: boolean
  pendingBranchGroup: string | null
  interrupted: boolean
  /** An interim finalized a bubble mid-turn. */
  interimBoundaryPending: boolean
  /** A blocking clarify prompt is waiting → sidebar "needs input". */
  needsInput: boolean
  /** Per-session turn clock (epoch ms). */
  turnStartedAt: number | null
  /** Per-session runtime clock (epoch ms), set when the session is created. */
  sessionStartedAt: number | null
  /** Per-session transient status text (the gateway's `status.update`). */
  statusLine: string
  /** Backend-pushed auto-title, before the session appears in the stored list. */
  liveTitle: string
  /** Last write, for LRU eviction (store/session-states.ts). */
  lastTouchedAt: number
  /** Per-session cumulative token usage. */
  usage: null | UsageStats
}

// ---------------------------------------------------------------------------
// Session keys. A session's map key is its RUNTIME id once it has one. Before
// that it still needs a slice — an unsaved draft must own its transcript like
// any other session, otherwise the active key is null and every foreign
// session's events fall through the "is this mine?" test (the MJX-132
// fail-open). So drafts and in-flight resumes get stable placeholder keys and
// are `rekeySession`d onto the real runtime id the moment the gateway hands one
// back.
// ---------------------------------------------------------------------------

export const DRAFT_KEY_PREFIX = 'draft:'
export const HYDRATING_KEY_PREFIX = 'hydrating:'

let draftCounter = 0

/** A fresh draft key. Counter-scoped so several unsaved chats can coexist (the
 *  mobile bubble strip allows more than one). */
export const newDraftKey = (): string => `${DRAFT_KEY_PREFIX}${++draftCounter}`

/** The key a stored session hydrates under until its resume returns a runtime id. */
export const hydratingKey = (storedSessionId: string): string => `${HYDRATING_KEY_PREFIX}${storedSessionId}`

export const isDraftKey = (key: string): boolean => key.startsWith(DRAFT_KEY_PREFIX)

export const isPlaceholderKey = (key: string): boolean =>
  key.startsWith(DRAFT_KEY_PREFIX) || key.startsWith(HYDRATING_KEY_PREFIX)

/** An empty state for a freshly-opened session before its resume binds. */
export function emptySessionState(storedSessionId: string | null = null): ClientSessionState {
  return {
    runtimeSessionId: null,
    storedSessionId,
    messages: [],
    branch: '',
    cwd: '',
    model: '',
    provider: '',
    reasoningEffort: '',
    serviceTier: '',
    fast: false,
    yolo: false,
    personality: '',
    busy: false,
    awaitingResponse: false,
    streamId: null,
    sawAssistantPayload: false,
    pendingBranchGroup: null,
    interrupted: false,
    interimBoundaryPending: false,
    needsInput: false,
    turnStartedAt: null,
    sessionStartedAt: null,
    statusLine: '',
    liveTitle: '',
    lastTouchedAt: 0,
    usage: null
  }
}

/** Session key → state, for EVERY session. Republished on every message delta;
 *  derived sets guard with `stableArray` to avoid re-render storms. */
export const $sessionStates = atom<Record<string, ClientSessionState>>({})

/**
 * The key of the session the user is looking at — the map key, NEVER null.
 *
 * Deliberately distinct from `store/chat.ts`'s `$sessionId` (the gateway's
 * runtime id, which IS null for a draft and is what goes on the wire). Keeping
 * them separate is what lets the event router ask "is this event mine?" with a
 * value that always answers.
 */
export const $activeSessionKey = atom<string>(newDraftKey())

// ---------------------------------------------------------------------------
// THE MAP WRITE PATH.
//
// These live in the leaf, not in `store/session-states.ts`, because
// `store/chat.ts` needs them and `store/session-states.ts` reaches
// `store/session.ts` (which imports `store/chat.ts`) — putting the writers here
// keeps that from closing into a runtime cycle. The richer transition
// behaviour (stall watchdog, settle grace, unread markers, id rotation) plugs in
// through `setSessionTransitionHook`, and slice teardown through
// `setSessionDisposeHook`.
// ---------------------------------------------------------------------------

type TransitionHook = (previous: ClientSessionState | null, next: ClientSessionState, key: string) => void

let transitionHook: TransitionHook | null = null
let disposeHook: null | ((key: string, state: ClientSessionState) => void) = null

export function setSessionTransitionHook(hook: TransitionHook): void {
  transitionHook = hook
}

export function setSessionDisposeHook(hook: (key: string, state: ClientSessionState) => void): void {
  disposeHook = hook
}

// --- Stored id → session key reverse index --------------------------------
//
// Callers navigate by STORED id (a sidebar row, a tile, a bubble) but slices are
// keyed by the live session key, so every "is this session already open?" test
// needs this map. It also carries LINEAGE ALIASES: when a session auto-compacts
// its stored id rotates, and bubbles / tiles / layout pane ids / the persisted
// `hermes.*` blobs all still name the PRE-rotation id. Aliasing the old id onto
// the live key keeps every one of them resolving without renaming anything or
// migrating storage (MJX-133).

const keyByStoredId = new Map<string, string>()

function indexStoredId(prev: ClientSessionState | null, next: ClientSessionState, key: string) {
  if (prev?.storedSessionId && prev.storedSessionId !== next.storedSessionId) {
    // Keep the old id pointing here — it is the same conversation, and the
    // callers holding it have no way to learn about the rotation.
    keyByStoredId.set(prev.storedSessionId, key)
  }

  if (next.storedSessionId) {
    keyByStoredId.set(next.storedSessionId, key)
  }
}

function dropStoredIdIndexFor(key: string) {
  for (const [storedId, mapped] of keyByStoredId) {
    if (mapped === key) {
      keyByStoredId.delete(storedId)
    }
  }
}

function remapStoredIdIndex(key: string, nextKey: string) {
  for (const [storedId, mapped] of keyByStoredId) {
    if (mapped === key) {
      keyByStoredId.set(storedId, nextKey)
    }
  }
}

/**
 * The live session key for a stored session, or null when it isn't open.
 *
 * Validated like desktop's `getRuntimeIdForStoredSession`: a hit is only
 * returned when the slice still exists — either under its current stored id, or
 * under one we deliberately aliased across a compaction rotation.
 */
export function runtimeKeyForStoredSession(storedSessionId: null | string): null | string {
  if (!storedSessionId) {
    return null
  }

  const key = keyByStoredId.get(storedSessionId)

  if (!key) {
    return null
  }

  if (!(key in $sessionStates.get())) {
    keyByStoredId.delete(storedSessionId)

    return null
  }

  return key
}

/** Register a stored id as an alias of an already-open session — used to seed
 *  the index from the backend's `_lineage_root_id` on a session-list refresh. */
export function aliasStoredSessionId(aliasStoredId: string, liveStoredId: string): void {
  const key = runtimeKeyForStoredSession(liveStoredId)

  if (key && !keyByStoredId.has(aliasStoredId)) {
    keyByStoredId.set(aliasStoredId, key)
  }
}

export function clearStoredIdIndex(): void {
  keyByStoredId.clear()
}

// --- Writers ---------------------------------------------------------------

/** Publish one session's state, firing the transition side-effects by diffing
 *  previous vs next. */
export function publishSessionState(key: string, state: ClientSessionState): ClientSessionState {
  const prev = $sessionStates.get()[key] ?? null
  const next = { ...state, lastTouchedAt: Date.now() }
  $sessionStates.set({ ...$sessionStates.get(), [key]: next })
  indexStoredId(prev, next, key)
  transitionHook?.(prev, next, key)

  return next
}

/** Create a session's slice if absent, and return it either way. Every write
 *  path goes through here, so no caller can land on a missing slice. */
export function ensureSessionSlice(key: string, seed?: Partial<ClientSessionState>): ClientSessionState {
  const current = $sessionStates.get()[key]

  if (current) {
    return current
  }

  return publishSessionState(key, { ...emptySessionState(seed?.storedSessionId ?? null), ...seed })
}

/** THE per-session write path: apply an updater to one session's slice and
 *  publish it. Creates the slice when absent — the previous version returned
 *  `undefined` cast to a state, a latent crash the moment the visible chat
 *  started reading from the map. Mirrors desktop's `updateSession`. */
export function updateSession(
  key: string,
  updater: (state: ClientSessionState) => ClientSessionState
): ClientSessionState {
  const current = $sessionStates.get()[key] ?? ensureSessionSlice(key)
  const next = updater(current)

  return next === current ? current : publishSessionState(key, next)
}

/**
 * Move a slice from one key to another in ONE `$sessionStates.set`, so no
 * subscriber ever observes a frame where the session exists under neither key.
 * If the moving slice is the active one, `$activeSessionKey` follows in the same
 * tick.
 *
 * This is the draft→runtime and hydrating→runtime primitive. Callers must invoke
 * it synchronously once the gateway hands back a runtime id, before awaiting
 * anything else: the event router drops events for unknown keys, so the slice
 * has to exist under its real id before the first streamed event for it arrives.
 */
export function rekeySession(fromKey: string, toKey: string, patch?: Partial<ClientSessionState>): ClientSessionState {
  // Anything queued under the old key is this session's own output, so apply it
  // before the move rather than letting the teardown below discard it.
  flushDeltas(fromKey)

  const states = $sessionStates.get()
  const moving = states[fromKey] ?? emptySessionState()

  if (fromKey === toKey) {
    return publishSessionState(toKey, { ...moving, ...patch })
  }

  const prevAtTarget = states[toKey] ?? null
  const next = { ...moving, ...patch, lastTouchedAt: Date.now() }
  const { [fromKey]: _moved, ...rest } = states
  $sessionStates.set({ ...rest, [toKey]: next })

  // Carry every alias across, not just the current stored id — a session that
  // rotated before being rekeyed still has callers holding its older ids.
  remapStoredIdIndex(fromKey, toKey)
  indexStoredId(prevAtTarget, next, toKey)

  if ($activeSessionKey.get() === fromKey) {
    $activeSessionKey.set(toKey)
  }

  disposeHook?.(fromKey, moving)
  transitionHook?.(prevAtTarget, next, toKey)

  return next
}

/** Evict a session's slice entirely. */
export function dropSessionState(key: string): void {
  const current = $sessionStates.get()

  if (!(key in current)) {
    return
  }

  const state = current[key]
  dropStoredIdIndexFor(key)

  const { [key]: _dropped, ...rest } = current
  $sessionStates.set(rest)
  disposeHook?.(key, state)
}
