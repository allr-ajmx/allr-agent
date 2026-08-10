import { useStore } from '@nanostores/react'
import { type MouseEvent, useCallback } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import type { Role } from '@/lib/chat-messages'
import { triggerHaptic } from '@/lib/haptics'
import { QUICK_REACTIONS, toggleMessageReaction } from '@/store/reactions'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $localReactions, $reactionRowIds, NO_REACTIONS } from '@/store/reactions-local'
import type { MessageReaction } from '@/types/hermes'

/** The tapback a double-click lands: Apple's first Tapback, and ours. */
export const DOUBLE_CLICK_REACTION = QUICK_REACTIONS[0]

// Double-click means something else on these: links and controls act, inputs
// and code blocks select. The gesture only claims plain message body.
const NOT_A_TAPBACK = 'a, button, input, pre, select, textarea, [contenteditable="true"], [role="button"]'

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
 * A message's reactions and the one way to change them.
 *
 * Reads this window's live list, and hands back a `react` that paints locally
 * first and persists behind it. Shared by the assistant footer slot, the user
 * bubble's picker, and the double-click gesture, so all three apply identical
 * tapback semantics rather than three near-copies of them.
 */
export function useMessageReactions(
  messageId: string,
  role: Role
): {
  enabled: boolean
  react: (emoji: null | string) => void
  reactions: MessageReaction[]
} {
  const enabled = useStore($reactionsEnabled)
  const all = useStore($localReactions)
  const sessionId = useStore(useSessionView().$runtimeId) ?? ''

  return {
    enabled,
    // The row id is read at CLICK time, not closed over: it is learned from the
    // first response, and a callback pinned to the id at render time would keep
    // asking the backend to re-resolve "newest of this role" forever.
    react: useCallback(
      (emoji: null | string) =>
        void toggleMessageReaction({ id: messageId, role, rowId: $reactionRowIds.get()[messageId] }, sessionId, emoji),
      [messageId, role, sessionId]
    ),
    reactions: all[messageId] ?? NO_REACTIONS
  }
}

/**
 * Double-click a message to heart it — the iMessage gesture.
 *
 * Returns `undefined` while reactions are off, so the element carries no
 * listener at all.
 */
export function useTapbackDoubleClick(messageId: string, role: Role): ((event: MouseEvent) => void) | undefined {
  const enabled = useStore($reactionsEnabled)
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

      // Read the current state at EVENT time rather than subscribing: the
      // gesture renders nothing, so subscribing the perf-sensitive message root
      // to every reaction change would be pure cost.
      const mine = ($localReactions.get()[messageId] ?? NO_REACTIONS).find(reaction => reaction.author === 'user')

      void toggleMessageReaction(
        { id: messageId, role, rowId: $reactionRowIds.get()[messageId] },
        sessionId,
        mine?.emoji === DOUBLE_CLICK_REACTION ? null : DOUBLE_CLICK_REACTION
      )
    },
    [messageId, role, sessionId]
  )

  return enabled ? onDoubleClick : undefined
}
