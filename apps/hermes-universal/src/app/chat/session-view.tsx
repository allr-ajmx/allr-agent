import type { ReadableAtom } from 'nanostores'
import { createContext, useContext } from 'react'

import {
  $awaitingResponse,
  $busy,
  $currentCwd,
  $lastVisibleMessageIsUser,
  $messages,
  $messagesEmpty,
  $sessionId,
  type ChatMessage
} from '@/store/chat'
import { $currentFastMode, $currentModel, $currentProvider, $currentReasoningEffort } from '@/store/model'
import { $activeStoredSessionId } from '@/store/session'

/**
 * The store-surface a `ChatScreen` renders from — every field is a
 * `ReadableAtom`, so subscription granularity survives (a tile's token stream
 * never re-renders another). The PRIMARY view wires the global chat atoms; a
 * TILE view (`buildTileView` in session-tile.tsx) supplies the same shape
 * computed from its `$sessionStates` slice. ChatScreen reads only from
 * `useSessionView()`, so one component tree serves N sessions.
 *
 * Ported from desktop `app/chat/session-view.tsx`.
 */
export interface SessionView {
  kind: 'primary' | 'tile'
  $runtimeId: ReadableAtom<string | null>
  $storedId: ReadableAtom<string | null>
  $messages: ReadableAtom<ChatMessage[]>
  $busy: ReadableAtom<boolean>
  $awaitingResponse: ReadableAtom<boolean>
  $messagesEmpty: ReadableAtom<boolean>
  $lastVisibleIsUser: ReadableAtom<boolean>
  $cwd: ReadableAtom<string>
  $model: ReadableAtom<string>
  $provider: ReadableAtom<string>
  $fast: ReadableAtom<boolean>
  $reasoningEffort: ReadableAtom<string>
}

export const PRIMARY_SESSION_VIEW: SessionView = {
  kind: 'primary',
  $runtimeId: $sessionId,
  $storedId: $activeStoredSessionId,
  $messages,
  $busy,
  $awaitingResponse,
  $messagesEmpty,
  $lastVisibleIsUser: $lastVisibleMessageIsUser,
  $cwd: $currentCwd,
  $model: $currentModel,
  $provider: $currentProvider,
  $fast: $currentFastMode,
  $reasoningEffort: $currentReasoningEffort
}

const SessionViewContext = createContext<SessionView>(PRIMARY_SESSION_VIEW)

export const SessionViewProvider = SessionViewContext.Provider

export function useSessionView(): SessionView {
  return useContext(SessionViewContext)
}
