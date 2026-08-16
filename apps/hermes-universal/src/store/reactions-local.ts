/**
 * Reaction overlays and the pure tapback rules — a LEAF module.
 *
 * No gateway, no transcript, no imports back into `store/reactions.ts`. The
 * event router and the RPC half both reach in here, and neither can afford to
 * drag the other's dependencies along.
 *
 * TWO overlays, keyed differently on purpose. That difference is the whole
 * subtlety of this feature, so it is worth stating plainly:
 *
 *   - The USER's own click is keyed by RENDERER message id, because that is
 *     what the clicked component knows and the click has to paint before
 *     anything durable exists to key on.
 *   - The AGENT's reaction is keyed by DURABLE row id, because it arrives
 *     mid-turn and has to survive the end-of-turn resume — which rebuilds the
 *     transcript from the gateway's in-memory history and regenerates every
 *     renderer id in it. An overlay keyed on the old id would orphan at exactly
 *     the moment the reaction was supposed to persist.
 *
 * Both are overlays on top of the durable list the transcript carries
 * (`ChatMessage.reactions`), never a replacement for it.
 */

import { atom } from '@/store/atom'
import type { MessageReaction } from '@/types/hermes'

/** The six iOS Tapback defaults, in Apple's order. */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const

/** Stable empty identity — a fresh `[]` per read would re-render every consumer. */
export const NO_REACTIONS: MessageReaction[] = []

/**
 * Reactions the user has set in THIS window, keyed by renderer message id.
 *
 * A tapback is direct manipulation: it flips the instant you click it, with no
 * round-trip, no gateway, and no dependence on the message having been
 * persisted yet. Durable state still arrives through the transcript; this sits
 * on top so the interaction never waits on the backend to feel alive.
 */
export const $localReactions = atom<Record<string, MessageReaction[]>>({})

/**
 * Agent reactions announced live (`message.reaction`), keyed by DURABLE row id.
 *
 * Never the renderer message id — see the note at the top of this file. The
 * resume also rebuilds from the gateway's in-memory history, which does not
 * carry a reaction written to the DB mid-turn; this overlay outlives that
 * clobber, and a real reload hydrates the same reaction from disk.
 */
export const $agentReactions = atom<Record<number, MessageReaction[]>>({})

/**
 * Durable row ids learned from a `message.react` response, keyed by renderer
 * message id — so a second toggle addresses the row directly instead of asking
 * the backend to re-resolve "newest of this role", which by then may be a
 * different message.
 */
export const $reactionRowIds = atom<Record<string, number>>({})

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
 * Merge the durable reaction list with anything this window knows live.
 *
 * The user's slot: local wins (they just clicked it — newer by definition).
 * The agent's slot: the live-event overlay wins over persisted, because a
 * mid-turn reaction reaches the DB before the in-memory history the next resume
 * projects from. Each author is resolved independently, so one side being live
 * never hides the other.
 */
export function mergeReactions(
  persisted: MessageReaction[] | undefined,
  local: MessageReaction[] | undefined,
  agentLive?: MessageReaction[]
): MessageReaction[] {
  const persistedList = persisted ?? NO_REACTIONS

  const userSide = local
    ? local.filter(reaction => reaction.author === 'user')
    : persistedList.filter(reaction => reaction.author === 'user')

  const agentSide = agentLive ?? persistedList.filter(reaction => reaction.author === 'agent')

  if (userSide.length === 0 && agentSide.length === 0) {
    return NO_REACTIONS
  }

  return [...userSide, ...agentSide]
}

/** Toggle the user's reaction on a message — instant, local, no round-trip.
 *  Returns the list as it was BEFORE the change, for a rollback. */
export function setLocalReaction(messageId: string, emoji: null | string): MessageReaction[] {
  const all = $localReactions.get()
  const previous = all[messageId] ?? NO_REACTIONS

  $localReactions.set({ ...all, [messageId]: applyReaction(previous, emoji, 'user') })

  return previous
}

/** Overwrite the local overlay for a message, without toggle semantics. */
export function writeLocalReactions(messageId: string, reactions: MessageReaction[]): void {
  $localReactions.set({ ...$localReactions.get(), [messageId]: reactions })
}

/** Record an agent reaction painted from a live gateway event. */
export function recordAgentReaction(rowId: number, reactions: readonly MessageReaction[]): void {
  $agentReactions.set({
    ...$agentReactions.get(),
    [rowId]: reactions.filter(reaction => reaction.author === 'agent')
  })
}

/** Remember the durable row a renderer message turned out to be. */
export function rememberReactionRowId(messageId: string, rowId: number): void {
  if ($reactionRowIds.get()[messageId] === rowId) {
    return
  }

  $reactionRowIds.set({ ...$reactionRowIds.get(), [messageId]: rowId })
}

export function clearReactionOverlays(): void {
  $localReactions.set({})
  $agentReactions.set({})
  $reactionRowIds.set({})
}
