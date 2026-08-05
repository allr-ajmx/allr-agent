import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ReadableAtom } from 'nanostores'
import { type ReactNode, useEffect, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { usePaneVisible } from '@/components/pane-shell/pane-visibility'
import { useStore } from '@/store/atom'
import { type ChatMessage, submitEditedPrompt } from '@/store/chat'

// Bridges the chat store to assistant-ui via the stock external-store runtime.
// Our ChatMessage.parts ARE assistant-ui content parts, so conversion is a
// one-liner. (The desktop's ExportedMessageRepository / incremental runtime is
// for branching + perf — deferred; stock runtime is enough for v1.)
function convertMessage(message: ChatMessage): ThreadMessageLike {
  return {
    // MUST pass our own id through: `fromThreadMessageLike` falls back to a
    // generated one (`id ?? fallbackId`), and every id-addressed action then
    // speaks a vocabulary our store can't resolve. The edit composer sends
    // `sourceId = message.id`, so without this `submitEditedPrompt` never finds
    // the turn being edited and Enter silently does nothing; "branch in new
    // chat" likewise fell back to the last turn instead of the clicked one.
    id: message.id,
    role: message.role,
    content: message.parts as ThreadMessageLike['content'],
    status:
      message.role === 'assistant'
        ? message.error
          ? { type: 'incomplete', reason: 'error', error: message.error }
          : message.pending
            ? { type: 'running' }
            : { type: 'complete', reason: 'stop' }
        : undefined
  }
}

/**
 * The transcript, subscribed only while this pane is the VISIBLE tab.
 *
 * Keep-alive mounts every tab a zone has ever activated, which is what stops a
 * chat being rebuilt on every tab switch. Without this gate it also means N
 * live transcripts re-rendering on every streamed token — roughly 30 flushes a
 * second, times every busy tab, for pixels nobody can see. Keep-alive without
 * it is a regression on the thing it was meant to fix.
 *
 * A hidden tab freezes its transcript and catches up in ONE commit on reveal,
 * because nanostores' `subscribe` fires immediately with the current value.
 * Status stays live throughout — `$busy` and the session-status atoms are
 * separate, cheap, and deliberately left subscribed, so a background tab's
 * spinner and unread dot keep working while its message list sleeps.
 */
function useMessagesWhileVisible($messages: ReadableAtom<ChatMessage[]>): ChatMessage[] {
  const visible = usePaneVisible()
  const [messages, setMessages] = useState(() => $messages.get())

  // The cast is nanostores widening its listener value to `readonly T`; the
  // atom itself is declared as `ChatMessage[]` and never handed a frozen one.
  useEffect(
    () => (visible ? $messages.subscribe(value => setMessages(value as ChatMessage[])) : undefined),
    [$messages, visible]
  )

  return messages
}

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  // Read from the SessionView so a tile renders ITS session's transcript. The
  // default context is PRIMARY_SESSION_VIEW (whose $messages/$busy ARE the global
  // atoms), so the primary chat is unchanged.
  const view = useSessionView()
  const messages = useMessagesWhileVisible(view.$messages)
  const isRunning = useStore(view.$busy)

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    convertMessage,
    // Our own Composer submits via sendPrompt; assistant-ui's composer is unused,
    // so onNew is a no-op. FIXME(G8): wire if we adopt the assistant-ui composer.
    onNew: async () => {},
    // Editing a past prompt IS used: the inline edit composer sends through
    // here. `sourceId` is the message being replaced (`parentId` on the first
    // edit of a turn); submitting rewinds to it and re-runs with the new text.
    onEdit: async message => {
      const sourceId = message.sourceId ?? message.parentId
      const text = message.content.map(part => ('text' in part ? part.text : '')).join('')

      if (sourceId) {
        await submitEditedPrompt(sourceId, text)
      }
    }
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
