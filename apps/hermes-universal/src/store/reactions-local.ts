import { atom } from '@/store/atom'
import { applyReaction } from '@/store/reactions'
import type { MessageReaction } from '@/types/hermes'

/**
 * The reactions this window knows about, keyed by renderer message id.
 *
 * The UI owns this outright. A tapback is direct manipulation — it flips the
 * instant you click it, with no round-trip and no dependency on the message
 * having been persisted yet. `message.react` answers with the authoritative
 * list, which is written straight back over the optimistic one.
 *
 * Deliberately NOT part of the transcript model. `store/chat.ts` and the
 * session reducer describe what the agent said; a reaction is something the
 * reader did to it, and threading it through the message pipeline would make
 * every reaction a transcript mutation.
 */
export const $localReactions = atom<Record<string, MessageReaction[]>>({})

/**
 * Durable row ids learned from a `message.react` response, keyed by renderer
 * message id — so a second toggle addresses the row directly instead of asking
 * the backend to re-resolve "newest of this role", which by then may be a
 * different message.
 */
export const $reactionRowIds = atom<Record<string, number>>({})

/** Stable empty identity — a fresh `[]` per read would re-render every consumer. */
export const NO_REACTIONS: MessageReaction[] = []

export const reactionsFor = (messageId: string): MessageReaction[] => $localReactions.get()[messageId] ?? NO_REACTIONS

/** Toggle the user's reaction on a message — instant, local, no round-trip.
 *  Returns the list as it was BEFORE the change, for a rollback. */
export function setLocalReaction(messageId: string, emoji: null | string): MessageReaction[] {
  const all = $localReactions.get()
  const previous = all[messageId] ?? NO_REACTIONS

  $localReactions.set({ ...all, [messageId]: applyReaction(previous, emoji, 'user') })

  return previous
}

/** Overwrite a message's reactions with a list, without toggle semantics. */
export function writeReactions(messageId: string, reactions: MessageReaction[]): void {
  $localReactions.set({ ...$localReactions.get(), [messageId]: reactions })
}

/** The backend's answer wins over the optimistic paint; learn the row id too. */
export function setReactionsFromServer(messageId: string, reactions: MessageReaction[], rowId?: number): void {
  writeReactions(messageId, reactions)

  if (rowId !== undefined) {
    $reactionRowIds.set({ ...$reactionRowIds.get(), [messageId]: rowId })
  }
}
