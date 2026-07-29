import { translateNow } from '@/i18n'
import {
  appendAssistantTextPart,
  appendStreamPart,
  applyCompletion,
  applySettledReasoning,
  type ChatMessage,
  chatMessageText,
  type ChatPart,
  coerceStringList,
  coerceText,
  completionErrorText,
  finalizeParts,
  newAssistant,
  nextId,
  patchActive,
  type ReasoningPart,
  type Role,
  type TextPart,
  type ToolCallPart,
  withActiveAssistant
} from '@/lib/chat-messages'
import { stopSpeaking } from '@/lib/tts'
import { atom, computed } from '@/store/atom'
import { cwdForNewSession } from '@/store/default-project-dir'
import { requestGateway } from '@/store/gateway'
import { clearNotifications, notifyError } from '@/store/notifications'
import { setPetActivity } from '@/store/pet'
import { clearPreviewArtifacts } from '@/store/preview-status'
import {
  $approval,
  $clarify,
  $secret,
  $sudo,
  type ApprovalRequest,
  type ClarifyRequest,
  clearSessionApproval,
  clearSessionClarify,
  clearSessionSecret,
  clearSessionSudo,
  type SecretRequest,
  sessionClarifyRequest,
  sessionSecretRequest,
  sessionSudoRequest,
  type SudoRequest
} from '@/store/prompts'
import {
  $activeSessionKey,
  $sessionStates,
  type ClientSessionState,
  dropSessionState,
  emptySessionState,
  ensureSessionSlice,
  isDraftKey,
  newDraftKey,
  rekeySession,
  updateSession
} from '@/store/session-state-types'
import { clearSessionSubagents } from '@/store/subagents'
import type { SessionCreateResponse, UsageStats } from '@/types/hermes'

// The chat transcript model and its pure reducers now live in the LEAF module
// @/lib/chat-messages, so the unified session reducer can apply the exact same
// logic to every session's slice without importing this store. Re-exported here
// because ~10 modules and the tests import them from `@/store/chat`.
//
// Parts are exactly assistant-ui's content-part shapes (text / reasoning /
// tool-call), so conversion in app/chat/runtime.tsx is trivial. The tool-call
// reducer is the full desktop port (@/lib/chat-tool-parts).

export type { ChatMessage, ChatPart, ReasoningPart, Role, TextPart, ToolCallPart }
export {
  appendAssistantTextPart,
  appendStreamPart,
  applyCompletion,
  applySettledReasoning,
  chatMessageText,
  coerceStringList,
  coerceText,
  completionErrorText,
  finalizeParts,
  newAssistant,
  nextId,
  patchActive,
  withActiveAssistant
}

// The blocking-prompt request shapes live in store/prompts.ts (the owner of
// prompt state for every session); re-exported here for the existing sites.
export type { ApprovalRequest, ClarifyRequest, SecretRequest, SudoRequest }

export type ApprovalChoice = 'always' | 'deny' | 'once' | 'session'

const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000

// ---------------------------------------------------------------------------
// THE ACTIVE SESSION'S VIEW.
//
// None of these hold state. Every session — the one on screen, the ones in
// tiles, the ones behind mobile bubbles — stores its transcript and turn state
// in `$sessionStates`, and these are computed projections of whichever slice
// `$activeSessionKey` currently names. That is the whole point: a background
// session's tokens cannot reach the visible chat, because the visible chat has
// no storage of its own to reach (MJX-132).
//
// Writes go through `updateActive` / `updateSession(key, …)`.
// ---------------------------------------------------------------------------

/** The slice the user is looking at. */
const $active = computed([$activeSessionKey, $sessionStates], (key, states) => states[key] ?? EMPTY_STATE)

const EMPTY_STATE = emptySessionState()
const EMPTY_MESSAGES: ChatMessage[] = []

export const $messages = computed($active, state => state.messages ?? EMPTY_MESSAGES)
export const $busy = computed($active, state => state.busy)

export const $messagesEmpty = computed($messages, messages => messages.length === 0)

/** The last non-system message is the user's — i.e. we're waiting on the agent
 *  to start responding (used for the "thinking" placeholder). */
export const $lastVisibleMessageIsUser = computed($messages, messages => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role

    if (role === 'system') {
      continue
    }

    return role === 'user'
  }

  return false
})

/** A turn is submitted but the assistant hasn't produced visible output yet. */
export const $awaitingResponse = computed([$busy, $lastVisibleMessageIsUser], (busy, lastIsUser) => busy && lastIsUser)

export const $statusLine = computed($active, state => state.statusLine)

// The ACTIVE session's blocking prompts. Every session's prompt is stored keyed
// in store/prompts.ts; these are the active one's entries.
export { $approval, $clarify, $secret, $sudo }

/**
 * The gateway's LIVE session id for the active chat, or null for a draft that
 * has never been created. This is the wire-facing value (`prompt.submit`,
 * `session.interrupt`, `approval.respond`); the MAP key is `$activeSessionKey`,
 * which is never null. Keeping the two apart is what lets the event router ask
 * "is this event mine?" with a value that always answers.
 */
export const $sessionId = computed($active, state => state.runtimeSessionId)

// Live auto-title of the CURRENT runtime session, pushed by the backend's
// `session.title` event (the titler runs async after the first turn). A brand-new
// session isn't in the $sessions list yet and has no $activeStoredSessionId, so
// the chat header can't resolve its title from the list — it reads this instead,
// so the "New session" heading updates on the fly once the title lands.
export const $liveSessionTitle = computed($active, state => state.liveTitle)

// The ACTIVE chat's working directory — its project directory. Every stored
// session carries one (`SessionInfo.cwd`), so switching chats switches this for
// free now that it lives on the slice: restored on open/resume
// (store/session.ts), adopted on create (ensureSession), and followed live via
// `session.info` when the agent relocates itself. Empty for a detached chat (no
// project dir) — consumers should generally read `$effectiveCwd`
// (store/workspace-events), which falls back to the workspace root.
export const $currentCwd = computed($active, state => state.cwd)

export function setCurrentCwd(cwd: null | string | undefined): void {
  updateActive(state => ({ ...state, cwd: cwd?.trim() || '' }))
}

// --- Statusbar runtime signals (turn/session timers + live context usage) ---
// Mirrors desktop's session-store $turnStartedAt/$sessionStartedAt/$currentUsage,
// wired here since chat.ts owns the turn lifecycle. The statusbar reads these for
// its running-timer, session-timer, and context-usage items.
// Rotates the empty-state tagline (components/chat/intro.tsx): bumped on every
// new chat so a fresh thread greets differently. Desktop's $introSeed, set from
// its new-chat action; universal has one reset path, so it lives with it.
export const $introSeed = atom<number>(0)

const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }
export const $turnStartedAt = computed($active, state => state.turnStartedAt)
export const $sessionStartedAt = computed($active, state => state.sessionStartedAt)
export const $currentUsage = computed($active, state => state.usage ?? EMPTY_USAGE)

/** Apply an updater to the ACTIVE session's slice. */
function updateActive(updater: (state: ClientSessionState) => ClientSessionState): void {
  updateSession($activeSessionKey.get(), updater)
}

/** Apply a transcript transform to the ACTIVE session's slice. */
function update(fn: (messages: ChatMessage[]) => ChatMessage[]): void {
  updateActive(state => ({ ...state, messages: fn(state.messages) }))
}

/**
 * Lazily create the session (needed before prompt.submit or file.attach).
 * Returns the live gateway `id` (used for prompt.submit / file.attach) AND the
 * durable `storedId` — session.create returns both, and the backend keys the
 * session LIST + `session.title` events on the stored id (which can differ from
 * the runtime id). The sidebar row + $activeStoredSessionId must use `storedId`
 * so the chat header can resolve the session after the list refreshes.
 */
export async function ensureSession(): Promise<{ id: string; storedId: string }> {
  const existing = $sessionId.get()

  if (existing) {
    return { id: existing, storedId: existing }
  }

  // A configured default project directory pre-attaches new LOCAL chats to that
  // folder (desktop parity); the gateway resolves its own default cwd otherwise.
  const cwd = cwdForNewSession()
  const draftKey = $activeSessionKey.get()

  const created = await requestGateway<SessionCreateResponse>('session.create', {
    cols: 96,
    ...(cwd && { cwd })
  })

  const id = created.session_id
  const storedId = created.stored_session_id ?? id

  // Move the draft's slice onto its real runtime id SYNCHRONOUSLY, before the
  // caller submits the prompt. The router drops events for unknown keys, so the
  // slice must already be reachable under `id` when the first delta lands.
  //
  // `setCurrentCwd` here would race the rekey, so the resolved cwd is folded in
  // as part of the same write: the runtime normalizes (or defaults) whatever we
  // asked for, and that is the directory the agent will actually run in.
  //
  // The session clock starts on create (statusbar session timer); resumed
  // sessions have no reliable start on this client, so it stays hidden for them.
  rekeySession(draftKey, id, {
    runtimeSessionId: id,
    storedSessionId: storedId,
    cwd: (created.info?.cwd ?? cwd ?? '').trim(),
    sessionStartedAt: Date.now()
  })

  return { id, storedId }
}

/**
 * Append a client-side system line to the transcript. Slash output rides this
 * (wrapped by `slashStatusText` into the `slash:<cmd>` envelope the
 * SystemMessage chip parses); nothing else emits system messages today.
 */
export function appendSystemMessage(text: string): void {
  const body = text.trim()

  if (!body) {
    return
  }

  update(messages => [...messages, { id: nextId(), role: 'system', parts: [{ type: 'text', text: body }] }])
}

export async function sendPrompt(text: string): Promise<void> {
  const trimmed = text.trim()

  if (!trimmed || $busy.get()) {
    return
  }

  stopSpeaking() // silence any TTS when the user sends a new prompt

  // The SUBMITTING session, not the on-screen one. `ensureSession` rekeys a
  // draft onto its runtime id mid-flight, and the user can switch chats while
  // the submit is in the air — so the optimistic turn and the failure rollback
  // are both addressed to the session that actually sent the prompt.
  const startKey = $activeSessionKey.get()

  updateSession(startKey, state => ({
    ...state,
    busy: true,
    turnStartedAt: Date.now(),
    statusLine: '',
    messages: [...state.messages, { id: nextId(), role: 'user', parts: [{ type: 'text', text: trimmed }] }]
  }))
  setPetActivity({ busy: true }) // pet: start working the moment the user sends

  // A draft rekeys to its runtime id, so the slice moves; anything else keeps
  // the key it started with.
  let submitKey = startKey

  try {
    const wasNew = !$sessionId.get()
    const { id: sessionId, storedId } = await ensureSession()
    submitKey = wasNew ? sessionId : startKey

    if (wasNew) {
      // New chat: optimistically add it to the sidebar list + mark active, keyed
      // on the STORED id (what the list refresh + session.title use), with the
      // first message as the provisional title (preview). Dynamic import —
      // store/session imports store/chat, so a static import here would cycle.
      void import('@/store/session').then(m => m.registerNewSession(storedId, trimmed)).catch(() => {})
    }

    await requestGateway('prompt.submit', { session_id: sessionId, text: trimmed }, PROMPT_SUBMIT_TIMEOUT_MS)
  } catch (err) {
    updateSession(submitKey, state => ({
      ...state,
      busy: false,
      turnStartedAt: null,
      statusLine: err instanceof Error ? err.message : String(err)
    }))

    if (submitKey === $activeSessionKey.get()) {
      setPetActivity({ busy: false, reasoning: false, toolRunning: false })
    }

    notifyError(err, 'Message failed to send')
  }
}

/** How the transcript should be rewound to re-run an edited prompt. */
export interface EditPlan {
  editedMessage: ChatMessage
  /** The original turn errored before reaching the gateway, so there is nothing
   *  to truncate — resubmit plainly instead (a truncate would 422). */
  isFailedTurn: boolean
  sourceIndex: number
  text: string
  truncateOrdinal?: number
}

/**
 * Resolve an edit of `sourceId` to `rawText` against the current transcript.
 * Returns null when the edit is a no-op (same text) or the target isn't a user
 * turn. Ported from desktop's `planEdit` (use-prompt-actions/rewind.ts).
 */
export function planEdit(messages: ChatMessage[], sourceId: string, rawText: string): EditPlan | null {
  const text = rawText.trim()
  const sourceIndex = messages.findIndex(message => message.id === sourceId)
  const source = messages[sourceIndex]

  if (!text || !source || source.role !== 'user') {
    return null
  }

  const currentText = source.parts
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()

  if (currentText === text) {
    return null
  }

  const nextMessage = messages[sourceIndex + 1]
  const isFailedTurn = nextMessage?.role === 'assistant' && Boolean(nextMessage.error)

  // The backend truncates by USER-turn ordinal, so count only the user turns
  // ahead of this one.
  const truncateOrdinal = messages.slice(0, sourceIndex).filter(message => message.role === 'user').length

  return {
    editedMessage: { ...source, parts: [{ type: 'text', text }], error: undefined, pending: false },
    isFailedTurn,
    sourceIndex,
    text,
    truncateOrdinal: isFailedTurn ? undefined : truncateOrdinal
  }
}

const isSessionBusyError = (error: unknown): boolean =>
  /session busy/i.test(error instanceof Error ? error.message : String(error))

const isStaleTargetError = (error: unknown): boolean =>
  /no longer in session history|not in session history/i.test(error instanceof Error ? error.message : String(error))

/**
 * Rewind a turn: `prompt.submit` with an optional `truncate_before_user_ordinal`
 * (drops that user turn + everything after). Idle rewinds submit directly —
 * interrupting an idle agent can leave a stale interrupt flag that cancels the
 * fresh turn; live turns interrupt first, and a raced "session busy" response
 * interrupts + retries. Ported from desktop's `runRewindSubmit`.
 */
async function runRewindSubmit(
  sessionId: string,
  text: string,
  truncateOrdinal: number | undefined,
  interruptFirst: boolean
): Promise<void> {
  const interrupt = async () => {
    try {
      await requestGateway('session.interrupt', { session_id: sessionId })
    } catch {
      // Best-effort. The submit path still gates on the gateway state.
    }
  }

  const submit = () =>
    requestGateway(
      'prompt.submit',
      {
        session_id: sessionId,
        text,
        ...(truncateOrdinal !== undefined && { truncate_before_user_ordinal: truncateOrdinal })
      },
      PROMPT_SUBMIT_TIMEOUT_MS
    )

  if (interruptFirst) {
    await interrupt()
  }

  try {
    await submit()
  } catch (err) {
    if (!isSessionBusyError(err)) {
      throw err
    }

    await interrupt()
    await submit()
  }
}

/**
 * Send an edited prompt: rewind the transcript to that turn and re-run it with
 * the new text. Optimistically truncates everything after the edited message so
 * the abandoned replies disappear immediately, and rolls the whole transcript
 * back if the gateway rejects. Ported from desktop's `editMessage`.
 */
export async function submitEditedPrompt(sourceId: string, rawText: string): Promise<void> {
  const sessionId = $sessionId.get()
  const messages = $messages.get()
  const plan = sessionId ? planEdit(messages, sourceId, rawText) : null

  if (!sessionId || !plan) {
    return
  }

  // The turns being discarded belong to an abandoned timeline: silence any TTS
  // reading them, drop their toasts, and clear the preview artifacts they
  // produced before the re-run repopulates. Desktop also clears todos and
  // background rows here (use-prompt-actions/index.ts); universal needs neither
  // — todos are derived from the transcript (lib/todos.ts `latestSessionTodos`),
  // so the truncation below drops them, and store/composer-status.ts is a
  // presence-only stub with no background rows to reset.
  stopSpeaking()
  clearNotifications()
  clearPreviewArtifacts(sessionId)

  const wasBusy = $busy.get()
  // Captured before the await: a mid-edit chat switch must not apply this
  // truncation (or its rollback) to whichever session is on screen when the
  // submit settles.
  const editKey = $activeSessionKey.get()

  updateSession(editKey, state => ({
    ...state,
    busy: true,
    turnStartedAt: Date.now(),
    statusLine: '',
    messages: [...messages.slice(0, plan.sourceIndex), plan.editedMessage]
  }))

  try {
    await runRewindSubmit(sessionId, plan.text, plan.truncateOrdinal, wasBusy)
  } catch (err) {
    // The target turn moved under us (e.g. auto-compression rotated the
    // history). We already interrupted, so land the text as a plain resend.
    if (!plan.isFailedTurn && isStaleTargetError(err)) {
      try {
        await runRewindSubmit(sessionId, plan.text, undefined, false)

        return
      } catch {
        // Fall through to the rollback below with the original error.
      }
    }

    // Restore the pre-edit transcript so the UI matches what's persisted
    // instead of stranding a partial timeline.
    updateSession(editKey, state => ({
      ...state,
      busy: false,
      turnStartedAt: null,
      statusLine: err instanceof Error ? err.message : String(err),
      messages
    }))
    notifyError(err, translateNow('desktop.editFailed'))
  }
}

// The prompt responders answer for ONE session. They default to the active one
// (that is where the composer bars live), but take an explicit key so a tile's
// or a background bubble's bars can answer their own session.

export async function respondApproval(choice: ApprovalChoice, key = $activeSessionKey.get()): Promise<void> {
  const sessionId = $sessionStates.get()[key]?.runtimeSessionId
  clearSessionApproval(key)
  clearAwaitingInputPose(key)

  try {
    await requestGateway('approval.respond', { choice, session_id: sessionId ?? undefined })
  } catch {
    /* turn may have moved on */
  }
}

/** Answer the pending clarify. Unlike the other prompt responders this does NOT
 *  clear optimistically: the inline panel keeps the question on screen and
 *  surfaces the error if the send fails, so the user can retry instead of losing
 *  the (still-blocked) prompt. Throws on failure. */
export async function respondClarify(answer: string, key = $activeSessionKey.get()): Promise<void> {
  const req = sessionClarifyRequest(key).get()

  if (!req) {
    return
  }

  await requestGateway('clarify.respond', { request_id: req.requestId, answer })

  // Only drop the request once the gateway has it; `tool.complete` lands next
  // and swaps the inline panel to its settled Q&A view.
  if (sessionClarifyRequest(key).get()?.requestId === req.requestId) {
    clearSessionClarify(key)
    clearAwaitingInputPose(key)
  }
}

export async function respondSudo(password: string, key = $activeSessionKey.get()): Promise<void> {
  const req = sessionSudoRequest(key).get()
  clearSessionSudo(key)
  clearAwaitingInputPose(key)

  if (!req) {
    return
  }

  try {
    await requestGateway('sudo.respond', { request_id: req.requestId, password })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondSecret(value: string, key = $activeSessionKey.get()): Promise<void> {
  const req = sessionSecretRequest(key).get()
  clearSessionSecret(key)
  clearAwaitingInputPose(key)

  if (!req) {
    return
  }

  try {
    await requestGateway('secret.respond', { request_id: req.requestId, value })
  } catch {
    /* turn may have moved on */
  }
}

/** The pet reflects what the USER is looking at, so answering a background
 *  session's prompt must not take it out of its waiting pose. */
function clearAwaitingInputPose(key: string): void {
  if (key === $activeSessionKey.get()) {
    setPetActivity({ awaitingInput: false })
  }
}

/**
 * Start a fresh, unsaved chat. The outgoing session KEEPS its slice — it may
 * still be streaming, and it is reachable from the sidebar, a tile or a bubble.
 * Only the active pointer moves, onto a brand-new draft.
 */
export function resetChat(): void {
  const previousKey = $activeSessionKey.get()
  const draftKey = newDraftKey()

  // A fresh chat starts in the configured default project dir (if any), not in
  // whatever directory the chat we just left happened to use.
  ensureSessionSlice(draftKey, { cwd: cwdForNewSession()?.trim() || '' })
  $activeSessionKey.set(draftKey)

  // Drop the OLD draft — an unsaved chat the user walked away from has nothing
  // to come back to. A real session keeps its slice, and keeps streaming.
  if (isDraftKey(previousKey)) {
    // Scoped teardown: `$subagentsBySession.set({})` used to run here, which
    // wiped every OTHER session's spawn tree too.
    clearSessionSubagents(previousKey)
    clearPreviewArtifacts(previousKey)
    dropSessionState(previousKey)
  }

  setPetActivity({}) // pet: clear any stale activity on chat teardown
  $introSeed.set($introSeed.get() + 1)
  stopSpeaking()
}
