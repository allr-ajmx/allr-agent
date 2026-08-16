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
import { $activeStoredSessionId, type BranchSource } from '@/store/session'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'

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

/**
 * The view, as the branch path wants it — a snapshot read at action time.
 *
 * `$runtimeId` is the slice KEY; `session.create`'s parent link and the "is
 * there anything to branch" refusal both want the WIRE id, which a draft — and
 * a slice still hydrating under a placeholder key — does not have. Resolved
 * exactly as `use-slash-command`'s `targetSessionId` resolves it, so the two
 * agree about when a surface has a session at all.
 */
export function branchSourceOf(view: SessionView): BranchSource {
  const key = view.$runtimeId.get()

  return {
    busy: view.$busy.get(),
    cwd: view.$cwd.get(),
    messages: view.$messages.get(),
    runtimeId: (key && $sessionStates.get()[key]?.runtimeSessionId) || null,
    storedId: view.$storedId.get()
  }
}

const SessionViewContext = createContext<SessionView>(PRIMARY_SESSION_VIEW)

export const SessionViewProvider = SessionViewContext.Provider

export function useSessionView(): SessionView {
  return useContext(SessionViewContext)
}
