import { ThreadPrimitive } from '@assistant-ui/react'
import { createContext, useCallback, useContext, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Intro } from '@/components/chat/intro'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useI18n } from '@/i18n'
import { userTurnOrdinal } from '@/lib/chat-messages'
import { interruptSession, restoreToMessage } from '@/store/chat'

import { AssistantMessage } from './assistant-message'
import { ThreadMessageList } from './list'
import { ResponseLoadingIndicator } from './status'
import { SystemMessage } from './system-message'
import { ThreadTimeline } from './timeline'
import { type RestoreMessageTarget } from './types'
import { UserEditComposer } from './user-edit-composer'
import { UserMessage } from './user-message'

// New-conversation empty state — desktop's <Intro>: the auto-fit "HERMES AGENT"
// wordmark + a rotating neutral tagline. Centered and pushed above the docked
// composer by its measured height, matching desktop's placement.
const EmptyPlaceholder = (
  <div className="flex min-h-0 w-full flex-col items-center justify-center pt-[var(--composer-measured-height)]">
    <Intro />
  </div>
)

const LOADING_INDICATOR = <ResponseLoadingIndicator />

/**
 * How a user bubble asks for the restore confirm.
 *
 * A CONTEXT rather than a prop because the message component types must be
 * module constants: ThreadMessageList is memo'd, and a fresh component type on
 * any render unmounts and remounts every visible message — async-rendered shiki
 * blocks collapse and re-expand, and the whole transcript visibly jumps. Desktop
 * routes the same callbacks through a ref for the same reason; a context keeps
 * the type stable AND keeps each mounted Thread (the main pane and every tile)
 * talking to its own dialog.
 */
const RestoreRequestContext = createContext<((messageId: string, target: RestoreMessageTarget) => void) | null>(null)

/** The wired user bubble: Stop on the live turn, restore-checkpoint on the rest.
 *  Both were rendered but unreachable — `UserMessage` was mounted with no props
 *  at all, so `onRequestRestoreConfirm` had no caller (MJXHRM-370) and the
 *  bubble's Stop was dead alongside it. */
function InteractiveUserMessage() {
  const sessionKey = useSessionView().$runtimeId
  const requestRestore = useContext(RestoreRequestContext)

  const onCancel = useCallback(() => {
    const key = sessionKey.get()

    if (key) {
      void interruptSession(key)
    }
  }, [sessionKey])

  return <UserMessage onCancel={onCancel} onRequestRestoreConfirm={requestRestore ?? undefined} />
}

const MESSAGE_COMPONENTS = {
  AssistantMessage,
  SystemMessage,
  UserEditComposer,
  UserMessage: InteractiveUserMessage
}

interface RestoreConfirmTarget extends RestoreMessageTarget {
  messageId: string
  /** Locator fallback for `planRestore`, counted over the session's OWN messages. */
  userOrdinal: null | number
}

// The chat thread. ThreadMessageList (ported from desktop) owns stick-to-bottom
// scrolling: it follows while parked at the bottom, escapes on scroll-up, pins
// the latest human message to the top of its turn while the reply streams, and
// groups each user prompt with the assistant turn(s) that follow it.
//
// The inline UserEditComposer is wired: clicking a user bubble opens it, and
// sending rewinds to that turn and re-runs it (runtime `onEdit` →
// submitEditedPrompt). The restore-checkpoint flow is wired here too: the
// bubble's discard button asks for a confirm, and confirming rewinds to that
// prompt and re-runs it unchanged (`restoreToMessage`). ThreadTimeline only reads
// s.thread.messages and queries data-message-id, both of which the external-store
// runtime provides. The floating scroll-to-bottom button renders in
// chat-screen.tsx.
export function Thread() {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const view = useSessionView()
  const sessionKey = view.$runtimeId
  const [target, setTarget] = useState<null | RestoreConfirmTarget>(null)

  // The ordinal is resolved HERE, from the session's own message list, because
  // it is a store-global count and the bubble that asked can only see the
  // windowed tail assistant-ui was handed. Read (never subscribed) at click
  // time: subscribing every mounted bubble to the transcript would re-render
  // the whole thread on each streamed token, and click time is exactly when the
  // fallback wants to have been captured — `planRestore` uses it only if an
  // auto-compaction re-keys the message before the confirm lands.
  const requestRestore = useCallback(
    (messageId: string, restoreTarget: RestoreMessageTarget) => {
      setTarget({ messageId, ...restoreTarget, userOrdinal: userTurnOrdinal(view.$messages.get(), messageId) })
    },
    [view]
  )

  const closeRestore = useCallback(() => setTarget(null), [])

  // Read at CONFIRM time, not at click time: the resolved key is what the
  // destructive rewind runs against, and the dialog is modal but the session
  // underneath it is not frozen.
  const confirmRestore = useCallback(async () => {
    if (!target) {
      return
    }

    const key = sessionKey.get()
    const { messageId, text, userOrdinal } = target

    // No key, no rewind. `restoreToMessage` defaults an omitted key to the
    // ACTIVE chat, which is the one thing a rewind opened from a tile or a
    // satellite window must never resolve to: hydrated ids are positional
    // (`h${index}-${role}`), so this surface's id resolves against the visible
    // chat's transcript and would truncate a conversation the user never
    // pointed at. Refusing is the only safe reading of "I don't know which
    // session this is".
    if (!key) {
      throw new Error(t.desktop.restoreNoSession)
    }

    // Throws on failure, which ConfirmDialog turns into an inline error and
    // keeps itself open for — the alternative (closing optimistically) leaves a
    // truncated transcript with nothing explaining it.
    await restoreToMessage(messageId, { text, userOrdinal }, key)
    setTarget(null)
  }, [sessionKey, t, target])

  const restoreDialog = useMemo(
    () => (
      <ConfirmDialog
        confirmLabel={copy.restoreConfirm}
        description={copy.restoreBody}
        destructive
        onClose={closeRestore}
        onConfirm={confirmRestore}
        open={Boolean(target)}
        title={copy.restoreTitle}
      />
    ),
    [closeRestore, confirmRestore, copy.restoreBody, copy.restoreConfirm, copy.restoreTitle, target]
  )

  return (
    <RestoreRequestContext.Provider value={requestRestore}>
      <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col bg-transparent contain-[layout_paint]">
        <ThreadMessageList
          clampToComposer
          components={MESSAGE_COMPONENTS}
          emptyPlaceholder={EmptyPlaceholder}
          loadingIndicator={LOADING_INDICATOR}
        />
        <ThreadTimeline />
        {restoreDialog}
      </ThreadPrimitive.Root>
    </RestoreRequestContext.Provider>
  )
}
