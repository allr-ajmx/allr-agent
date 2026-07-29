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
