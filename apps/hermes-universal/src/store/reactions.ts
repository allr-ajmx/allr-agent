/**
 * Tapbacks — the persistence half.
 *
 * The wire call itself lives in `lib/gateway-rpc.ts` (`reactToMessage`), which
 * spells the gateway's hand-parsed parameter names. This module owns the two
 * things that call cannot: the local mirror of the server's one-per-author
 * rule, and the optimistic write that keeps a tapback feeling like direct
 * manipulation instead of a round-trip.
 */

import { type ChatMessage } from '@/lib/chat-messages'
import { reactToMessage } from '@/lib/gateway-rpc'
import { notifyError } from '@/store/notifications'
import { setLocalReaction, setReactionsFromServer, writeReactions } from '@/store/reactions-local'
import type { MessageReaction } from '@/types/hermes'

/** The six iOS Tapback defaults, in Apple's order. */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const

/** Apply the local half of a tapback: one reaction per author, re-tap retracts. */
export function applyReaction(
  reactions: MessageReaction[] | undefined,
  emoji: null | string,
  author: MessageReaction['author']
): MessageReaction[] {
  const current = reactions ?? []
  const previous = current.find(reaction => reaction.author === author)
  const without = current.filter(reaction => reaction.author !== author)

  if (!emoji || previous?.emoji === emoji) {
    return without
  }

  return [...without, { at: Date.now() / 1000, author, emoji }]
}

/**
 * Toggle *author*'s reaction on a persisted message.
 *
 * Optimistic: the caller has already painted it locally, and this lets the
 * backend's returned list win afterwards. A failed write rolls back visibly and
 * says why, rather than the reaction quietly vanishing.
 */
export async function toggleMessageReaction(
  message: Pick<ChatMessage, 'id' | 'role'> & { rowId?: number },
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
      message.rowId === undefined
        ? ({ newest_role: message.role === 'user' ? 'user' : 'assistant' } as const)
        : ({ row_id: message.rowId } as const)

    const result = await reactToMessage({ author, emoji, sessionId, target })

    setReactionsFromServer(message.id, result?.reactions ?? [], result?.row_id)
  } catch (error) {
    // Be optimistic, THEN honest: a rejected write rolls back visibly and says
    // why, instead of the reaction quietly disagreeing with the server.
    writeReactions(message.id, snapshot)
    notifyError(error, 'Could not react')
  }
}
