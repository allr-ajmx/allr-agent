import { computed, type ReadableAtom } from 'nanostores'
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
import {
  $activeSessionKey,
  $sessionStates,
  type ClientSessionState,
  isDraftKey
} from '@/store/session-state-types'

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
 * Model/provider/fast/effort come from the active session's OWN slice once it is
 * live — that is where `session.info` lands (store/session-reducer) — and from
 * the model store's sticky globals only while the chat is still a draft. Reading
 * the globals for a live chat is how the pill named the last pick (or a
 * localStorage leftover) instead of the model the session was running, and
 * disagreed with the dropdown's gateway-authoritative checkmark. Desktop's
 * `primaryField` draws the same line; universal gates on the draft KEY because a
 * draft has a slice here, just an empty one.
 */
const $primaryLive = computed([$activeSessionKey, $sessionStates], (key, states) =>
  key && !isDraftKey(key) ? states[key] : undefined
)

function primaryField<T>(select: (state: ClientSessionState) => T, $draft: ReadableAtom<T>): ReadableAtom<T> {
  return computed([$primaryLive, $draft], (live, draft) => (live ? select(live) : draft))
}

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
  $model: primaryField(state => state.model, $currentModel),
  $provider: primaryField(state => state.provider, $currentProvider),
  $fast: primaryField(state => state.fast, $currentFastMode),
  $reasoningEffort: primaryField(state => state.reasoningEffort, $currentReasoningEffort)
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
