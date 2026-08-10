/**
 * Tapbacks — the half that talks to the gateway and writes the transcript.
 *
 * The wire call lives in `lib/gateway-rpc.ts` (`reactToMessage`); the pure
 * tapback rules and the two overlays live in `store/reactions-local.ts`. What
 * is here is the part that needs both: an optimistic user toggle, and the
 * inbound `message.reaction` event that paints the agent's own reaction.
 *
 * Both write the durable list onto the transcript row rather than only into an
 * overlay, because the transcript is what survives — an overlay is a patch over
 * the gap between an event landing and history catching up with it.
 */

import { reactToMessage } from '@/lib/gateway-rpc'
import { notifyError } from '@/store/notifications'
import {
  $reactionRowIds,
  recordAgentReaction,
  rememberReactionRowId,
  setLocalReaction,
  writeLocalReactions
} from '@/store/reactions-local'
import { $sessionStates, updateSession } from '@/store/session-state-types'
import type { MessageReaction } from '@/types/hermes'

export { applyReaction, QUICK_REACTIONS } from '@/store/reactions-local'

/** The message a reaction targets, as the caller knows it at click time. */
export interface ReactionTarget {
  id: string
  role: 'assistant' | 'user'
  /** Absent until the row has round-tripped — see `ChatMessage.rowId`. */
  rowId?: number
}

/**
 * Stamp a durable row id and its reactions onto one row of a session's
 * transcript.
 *
 * Matching is by ROW ID where the row knows one, and otherwise by "the newest
 * row of this role that has not yet round-tripped". That second leg is not a
 * convenience — it is the only way a live message can be matched at all. The
 * agent's default target is the newest message of a role, and a live row has no
 * durable id until a resume gives it one, so an id-only match would silently
 * find nothing on exactly the messages a user is most likely to be looking at.
 *
 * Matching the newest UNSTAMPED row rather than simply the newest is what keeps
 * it honest: a row that already carries a different `rowId` is a different
 * persisted message, and stamping this reaction onto it would paint a reaction
 * on the wrong bubble — worse than not painting at all.
 */
function stampRowReactions(
  sessionKey: string,
  rowId: number,
  role: 'assistant' | 'user',
  reactions: MessageReaction[]
): boolean {
  let matched = false

  updateSession(sessionKey, state => {
    const byRowId = state.messages.findIndex(message => message.rowId === rowId)
    let index = byRowId

    // `findLastIndex` is ES2023; the tsconfig lib predates it, and a manual
    // reverse scan reads no worse than the polyfill would.
    for (let i = state.messages.length - 1; index < 0 && i >= 0; i -= 1) {
      if (state.messages[i].role === role && state.messages[i].rowId === undefined) {
        index = i
      }
    }

    if (index < 0) {
      return state
    }

    matched = true

    return {
      ...state,
      // A NEW ChatMessage object per change is load-bearing: assistant-ui caches
      // normalized messages by object identity, so a mutation in place renders
      // stale.
      messages: state.messages.map((message, at) => (at === index ? { ...message, reactions, rowId } : message))
    }
  })

  return matched
}

/** The session slice a renderer message id currently lives in. */
function sessionKeyForMessage(messageId: string): null | string {
  for (const [key, state] of Object.entries($sessionStates.get())) {
    if (state.messages.some(message => message.id === messageId)) {
      return key
    }
  }

  return null
}

/**
 * Paint a `message.reaction` event — the agent reacting through its own tool.
 *
 * Already persisted by the time this arrives; this only shows it now instead of
 * at the next resume. The overlay is recorded alongside the transcript write
 * because the end-of-turn resume rebuilds from the gateway's in-memory history,
 * which does not carry a reaction written to the DB mid-turn.
 */
export function applyReactionEvent(
  sessionKey: string,
  rowId: number,
  role: 'assistant' | 'user',
  reactions: MessageReaction[]
): void {
  recordAgentReaction(rowId, reactions)
  stampRowReactions(sessionKey, rowId, role, reactions)
}

/**
 * Toggle *author*'s reaction on a message.
 *
 * Optimistic: the overlay paints immediately, then the backend's returned list
 * wins. A failed write rolls back visibly and says why, rather than the
 * reaction quietly disagreeing with the server.
 */
export async function toggleMessageReaction(
  message: ReactionTarget,
  sessionId: string,
  emoji: null | string,
  author: MessageReaction['author'] = 'user'
): Promise<void> {
  if (!sessionId) {
    notifyError(new Error('No active session'), 'Could not react')

    return
  }

  const snapshot = setLocalReaction(message.id, emoji)

  try {
    // A LIVE message has not round-tripped through a resume, so it carries no
    // row id. Rather than disable the affordance — which would make reactions
    // invisible in any active conversation — let the backend resolve the newest
    // row of this role, which is exactly the message being reacted to.
    const target =
      message.rowId === undefined ? ({ newest_role: message.role } as const) : ({ row_id: message.rowId } as const)

    const result = await reactToMessage({ author, emoji, sessionId, target })
    const reactions = result?.reactions ?? []

    writeLocalReactions(message.id, reactions)

    // Learn the row this turned out to be, so a second toggle addresses it
    // directly instead of asking the backend to re-resolve "newest of this
    // role" — which by then may be a different message.
    if (typeof result?.row_id === 'number') {
      rememberReactionRowId(message.id, result.row_id)

      const key = sessionKeyForMessage(message.id)

      if (key) {
        stampRowReactions(key, result.row_id, message.role, reactions)
      }
    }
  } catch (error) {
    // Be optimistic, THEN honest.
    writeLocalReactions(message.id, snapshot)
    notifyError(error, 'Could not react')
  }
}

/** Whether a renderer message has learned its durable row id. */
export const knownReactionRowId = (messageId: string): number | undefined => $reactionRowIds.get()[messageId]
