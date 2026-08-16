/**
 * SESSION DOT STATE, AS A MAP — the status a session is in, answerable for a
 * whole list at once rather than one row at a time.
 *
 * `SessionStatusDot` resolves its own state per row (four `useStoreSelector`
 * subscriptions, so a row repaints only when ITS membership flips) and that
 * stays the right shape for rendering. The sidebar's status FILTER and status
 * ORDERING ask a different question — "what is every session's state, right
 * now" — which a per-row hook cannot answer.
 *
 * Both go through the same `sessionDotState` resolver and the same
 * `sessionAliasIds` lineage rule, so the map and the painted dot can never
 * disagree about a session: this module decides nothing on its own.
 *
 * Ported from desktop `store/session-dot-state.ts`, minus its `background`
 * state — universal has no `$backgroundRunningSessionIds` equivalent (see
 * `app/chat/sidebar/session-row-state.ts`) — and minus `draft`, which is a
 * property of a surface with no stored session at all and so can never describe
 * a row in a list of stored sessions.
 */

import { type SessionDotState, sessionDotState } from '@/app/chat/sidebar/session-row-state'
import { computed } from '@/store/atom'

import {
  $attentionSessionIds,
  $sessions,
  $unreadFinishedSessionIds,
  $workingSessionIds,
  sessionAliasIds
} from './session'
import { $stalledSessionIds } from './session-states'

/** The buckets the sidebar's status filter and ordering work in. `stalled`
 *  folds into the state a user would name it. */
export type SessionStatusBucket = 'idle' | 'needs-input' | 'unread' | 'working'

export const sessionStatusBucket = (state: SessionDotState = 'idle'): SessionStatusBucket =>
  state === 'stalled' ? 'working' : state === 'draft' ? 'idle' : state

const STATUS_RANK: Record<SessionStatusBucket, number> = {
  'needs-input': 0,
  working: 1,
  unread: 2,
  idle: 3
}

/** Loudest first — what ordering by status sorts on. */
export const sessionStatusRank = (state?: SessionDotState): number => STATUS_RANK[sessionStatusBucket(state)]

/**
 * Every loaded session's dot state, keyed by its own id.
 *
 * Claimed under every alias a conversation answers to (auto-compression rotates
 * the stored id), so a row holding a pre-rotation tip is not reported `idle`
 * straight through a running turn — the same bug `sessionAliasIds` exists to
 * prevent on the dot itself.
 */
export const $sessionDotStateById = computed(
  [$sessions, $attentionSessionIds, $workingSessionIds, $stalledSessionIds, $unreadFinishedSessionIds],
  (sessions, attention, working, stalled, unread) => {
    const states: Record<string, SessionDotState> = {}

    for (const session of sessions) {
      const aliases = sessionAliasIds(session.id, session)

      states[session.id] = sessionDotState({
        isStalled: aliases.some(id => stalled.includes(id)),
        isUnread: aliases.some(id => unread.includes(id)),
        isWorking: aliases.some(id => working.has(id)),
        needsInput: aliases.some(id => attention.includes(id))
      })
    }

    return states
  }
)
