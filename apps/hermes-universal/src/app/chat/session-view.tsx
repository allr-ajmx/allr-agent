import type { ReadableAtom } from 'nanostores'
import { createContext, useContext } from 'react'

import {
  $awaitingResponse,
  $busy,
  $currentCwd,
  $lastVisibleMessageIsUser,
  $messages,
  $messagesEmpty,
  $statusLine,
  type ChatMessage
} from '@/store/chat'
import { $currentFastMode, $currentModel, $currentProvider, $currentReasoningEffort } from '@/store/model'
import { $activeStoredSessionId } from '@/store/session'
import { $activeSessionKey } from '@/store/session-state-types'

/**
 * The store-surface a `ChatScreen` renders from — every field is a
 * `ReadableAtom`, so subscription granularity survives (a tile's token stream
 * never re-renders another). Both views read the SAME map: the primary view is
 * the slice `$activeSessionKey` names, a TILE view (`buildTileView` in
 * session-tile.tsx) is the slice its stored id resolves to. ChatScreen reads
 * only from `useSessionView()`, so one component tree serves N sessions.
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
  $statusLine: ReadableAtom<string>
  $cwd: ReadableAtom<string>
  $model: ReadableAtom<string>
  $provider: ReadableAtom<string>
  $fast: ReadableAtom<boolean>
  $reasoningEffort: ReadableAtom<string>
}

/**
 * The view for the session on screen.
 *
 * `$runtimeId` is the session KEY, not `$sessionId` (the wire-facing runtime id,
 * which is null on a draft). Everything keyed off this view — per-session
 * composer scope, blocking-prompt bars, awaiting-input state — needs a handle
 * that a brand-new chat also has, and the key is that handle.
 *
 * Model/provider/fast/effort still come from the model store: those are app-wide
 * selections in universal, not per-session state.
 */
export const PRIMARY_SESSION_VIEW: SessionView = {
  kind: 'primary',
  $runtimeId: $activeSessionKey,
  $storedId: $activeStoredSessionId,
  $messages,
  $busy,
  $awaitingResponse,
  $messagesEmpty,
  $lastVisibleIsUser: $lastVisibleMessageIsUser,
  $statusLine,
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
