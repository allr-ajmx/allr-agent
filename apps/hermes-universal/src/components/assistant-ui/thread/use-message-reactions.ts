import { useAuiState, useMessageRuntime } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type MouseEvent, useCallback } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { triggerHaptic } from '@/lib/haptics'
import { QUICK_REACTIONS, type ReactionTarget, toggleMessageReaction } from '@/store/reactions'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import {
  $agentReactions,
  $localReactions,
  $reactionRowIds,
  mergeReactions,
  NO_REACTIONS
} from '@/store/reactions-local'
import type { MessageReaction } from '@/types/hermes'

/** The tapback a double-click lands: Apple's first Tapback, and ours. */
export const DOUBLE_CLICK_REACTION = QUICK_REACTIONS[0]

// Double-click means something else on these: links and controls act, inputs
// and code blocks select. The gesture only claims plain message body.
const NOT_A_TAPBACK = 'a, button, input, pre, select, textarea, [contenteditable="true"], [role="button"]'

/** What the transcript carries on a message, as assistant-ui surfaces it. */
interface ReactionMetadata {
  reactions?: MessageReaction[]
  rowId?: number
}

const reactionMetadata = (custom: unknown): ReactionMetadata => (custom ?? {}) as ReactionMetadata

/**
 * Is this double-click the "heart it" gesture?
 *
 * `detail === 2` keeps a triple-click (select-the-paragraph) from re-firing,
 * and anything the browser already gives a double-click meaning keeps it.
 */
export function isTapbackDoubleClick(event: { detail: number; target: EventTarget | null }): boolean {
  if (event.detail !== 2) {
    return false
  }

  const target = event.target

  return target instanceof Element ? !target.closest(NOT_A_TAPBACK) : true
}

/**
 * The row a reaction should address.
 *
 * The transcript's own `rowId` is preferred — it is the durable identity that
 * survives a resume. The learned map is the fallback for the window between a
 * `message.react` response and the transcript write that follows it.
 */
function resolveRowId(messageId: string, metadataRowId: number | undefined): number | undefined {
  return metadataRowId ?? $reactionRowIds.get()[messageId]
}

/**
 * A message's reactions and the one way to change them.
 *
 * Reads the durable list off the transcript, layers this window's live overlays
 * on top (the user's own click, the agent's mid-turn event), and hands back a
 * `react` that paints locally first and persists behind it. Shared by the
 * assistant footer slot, the user bubble's picker, and the double-click
 * gesture, so all three apply identical tapback semantics.
 */
export function useMessageReactions(
  messageId: string,
  role: ReactionTarget['role']
): {
  enabled: boolean
  react: (emoji: null | string) => void
  reactions: MessageReaction[]
} {
  const persisted = useAuiState(s => reactionMetadata(s.message.metadata?.custom).reactions ?? NO_REACTIONS)
  const rowId = useAuiState(s => reactionMetadata(s.message.metadata?.custom).rowId)

  const enabled = useStore($reactionsEnabled)
  const localAll = useStore($localReactions)
  const agentLive = useStore($agentReactions)
  const sessionId = useStore(useSessionView().$runtimeId) ?? ''

  return {
    enabled,
    // The row id is re-read at CLICK time rather than closed over: it is learned
    // from the first response, and a callback pinned to the id at render time
    // would keep asking the backend to re-resolve "newest of this role" forever.
    react: useCallback(
      (emoji: null | string) =>
        void toggleMessageReaction({ id: messageId, role, rowId: resolveRowId(messageId, rowId) }, sessionId, emoji),
      [messageId, role, rowId, sessionId]
    ),
    reactions: mergeReactions(persisted, localAll[messageId], rowId === undefined ? undefined : agentLive[rowId])
  }
}

/**
 * Double-click a message to heart it — the iMessage gesture.
 *
 * Reads the message's reaction state lazily at event time (the same trick the
 * footer uses for its text): the gesture renders nothing, so subscribing the
 * perf-sensitive message root to every reaction change would be pure cost.
 * Returns `undefined` while reactions are off, so the element carries no
 * listener at all.
 */
export function useTapbackDoubleClick(
  messageId: string,
  role: ReactionTarget['role']
): ((event: MouseEvent) => void) | undefined {
  const enabled = useStore($reactionsEnabled)
  const messageRuntime = useMessageRuntime()
  const sessionId = useStore(useSessionView().$runtimeId) ?? ''

  const onDoubleClick = useCallback(
    (event: MouseEvent) => {
      if (!isTapbackDoubleClick(event)) {
        return
      }

      // Double-click has already selected the word underneath — the tapback,
      // not a stray selection, is what the gesture meant.
      window.getSelection()?.removeAllRanges()
      triggerHaptic('selection')

      const metadata = reactionMetadata(messageRuntime.getState().metadata?.custom)
      const rowId = resolveRowId(messageId, metadata.rowId)

      // Same toggle semantics as the picker: a second double-click retracts.
      const mine = mergeReactions(metadata.reactions, $localReactions.get()[messageId]).find(
        reaction => reaction.author === 'user'
      )

      void toggleMessageReaction(
        { id: messageId, role, rowId },
        sessionId,
        mine?.emoji === DOUBLE_CLICK_REACTION ? null : DOUBLE_CLICK_REACTION
      )
    },
    [messageId, messageRuntime, role, sessionId]
  )

  return enabled ? onDoubleClick : undefined
}
