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
import { beginTurn, recordTurnCorrection, settleTurn } from '@/store/turn-lifecycle'
import type { SessionCreateResponse, SessionRedirectResponse, UsageStats } from '@/types/hermes'

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

/**
 * Stale-runtime recovery, loaded on demand.
 *
 * `store/session-recovery` needs the session's owning profile, so it imports
 * `store/session` — which imports THIS module and reads `$busy` / `$clarify` at
 * module scope (`$workingSessionIds`, `$attentionSessionIds`). A static import
 * here would close that cycle with chat.ts as a possible entry point, and
 * session.ts would then build those computeds against a `const` still in its
 * temporal dead zone. Deferred exactly like `registerNewSession` below.
 */
const sessionRecovery = () => import('@/store/session-recovery')

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

/**
 * Lazily create the session (needed before prompt.submit or file.attach).
 * Returns the live gateway `id` (used for prompt.submit / file.attach) AND the
 * durable `storedId` — session.create returns both, and the backend keys the
 * session LIST + `session.title` events on the stored id (which can differ from
 * the runtime id). The sidebar row + $activeStoredSessionId must use `storedId`
 * so the chat header can resolve the session after the list refreshes.
 */
export async function ensureSession(): Promise<{ created: boolean; id: string; storedId: string }> {
  const existing = $sessionId.get()

  if (existing) {
    // The slice's OWN stored id, not the runtime one. The two differ for any
    // session that was resumed (store/session.ts keys the slice by the runtime id
    // the resume handed back) and callers use `storedId` to recover a dead
    // runtime — resuming the runtime id would name a session the gateway has
    // already forgotten.
    return { created: false, id: existing, storedId: $active.get().storedSessionId ?? existing }
  }

  // A slice that already names a STORED session is NOT a new chat, whatever its
  // runtime binding says — only a draft has never been created. Without this
  // guard, anything that leaves a persisted conversation without a runtime id
  // turns the next message into `session.create`: the slice rekeys onto a fresh,
  // empty session, its `storedSessionId` is overwritten, and the user goes on
  // typing into a chat whose agent has none of the history still on screen. The
  // reconnect path used to do exactly that (MJXHRM-358); this is the invariant
  // that makes it unreachable no matter who clears the field next.
  //
  // Rebinding is the same resume `store/session-recovery.ts` runs for a dead
  // runtime id, and it rekeys onto the id it hands back, so the router addresses
  // the slice by the id the gateway will stamp on the reply. A failure THROWS —
  // the caller surfaces it and the turn rolls back, which is strictly better
  // than silently forking the conversation.
  const stored = $active.get().storedSessionId

  if (stored) {
    const { resumeStoredRuntimeSession } = await sessionRecovery()
    const live = await resumeStoredRuntimeSession(stored)

    if (!live) {
      throw new Error(`Session ${stored} could not be resumed`)
    }

    const key = $activeSessionKey.get()

    if (key === live) {
      updateSession(key, state => ({ ...state, runtimeSessionId: live }))
    } else {
      rekeySession(key, live, { runtimeSessionId: live, storedSessionId: stored })
    }

    return { created: false, id: live, storedId: stored }
  }

  // The draft's OWN directory wins: `startSessionInWorkspace` (store/session)
  // writes a just-created worktree there on the composer's branch-off hand-off,
  // and the session has to be created inside it rather than in the configured
  // default. Unlike that default this is NOT local-mode-gated — the path comes
  // from the backend's own repo (lib/desktop-git runs git where the gateway
  // lives), so it is meaningful remotely too. Otherwise a configured default
  // project directory pre-attaches new LOCAL chats to that folder (desktop
  // parity), and the gateway resolves its own default cwd if neither.
  const cwd = $currentCwd.get().trim() || cwdForNewSession()
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

  return { created: true, id, storedId }
}

/**
 * Append a client-side system line to ONE session's transcript. Slash output
 * rides this (wrapped by `slashStatusText` into the `slash:<cmd>` envelope the
 * SystemMessage chip parses); nothing else emits system messages today.
 *
 * Keyed rather than active-only because a slash command belongs to the surface
 * it was typed in, and a tile's composer is a different surface.
 */
export function appendSessionSystemMessage(key: string, text: string): void {
  const body = text.trim()

  if (!body || !key) {
    return
  }

  updateSession(key, state => ({
    ...state,
    messages: [...state.messages, { id: nextId(), role: 'system', parts: [{ type: 'text', text: body }] }]
  }))
}

/** The same, on the chat the user is looking at. */
export function appendSystemMessage(text: string): void {
  appendSessionSystemMessage($activeSessionKey.get(), text)
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
  // Open the in-flight turn NOW, not on `message.start`: the window between the
  // submit leaving and the gateway acknowledging it is precisely the one a
  // reconnect lands in, and a turn with no record there is a turn nothing can
  // reconcile (store/turn-lifecycle.ts).
  beginTurn(startKey, { prompt: trimmed })
  setPetActivity({ busy: true }) // pet: start working the moment the user sends

  // A draft rekeys to its runtime id, so the slice moves; anything else keeps
  // the key it started with.
  let submitKey = startKey

  try {
    // Both branches of `ensureSession` that go out to the gateway REKEY the
    // slice — a draft onto the session it just created, a persisted chat onto
    // the runtime the rebind handed back — so the submit and its rollback have
    // to follow. Only `created` gates the sidebar row: a rebind names a session
    // the list already holds, and registering it again would add a second row
    // for one conversation.
    const moved = !$sessionId.get()
    const { created, id: sessionId, storedId } = await ensureSession()
    submitKey = moved ? sessionId : startKey

    if (created) {
      // New chat: optimistically add it to the sidebar list + mark active, keyed
      // on the STORED id (what the list refresh + session.title use), with the
      // first message as the provisional title (preview). Dynamic import —
      // store/session imports store/chat, so a static import here would cycle.
      void import('@/store/session').then(m => m.registerNewSession(storedId, trimmed)).catch(() => {})
    }

    // The last unwired recovery site (MJXHRM-219): a session whose runtime the
    // gateway dropped while the user was away answers the first prompt back with
    // "session not found". Rebind and retry once.
    //
    // `onRecovered` REKEYS rather than taking the default alias: the resume hands
    // back a NEW runtime id, and the event router addresses slices by the id the
    // gateway stamps on each frame — so a slice left under the dead key would
    // stop receiving its own reply and sit busy forever. This is the same
    // mid-flight move `ensureSession` makes for a draft, in the same order
    // (`beginTurn` first), so the open turn follows it the same way.
    //
    // `alsoTimeout` stays OFF. A submit waits `PROMPT_SUBMIT_TIMEOUT_MS`, so a
    // timeout here does not mean "starved event loop, nothing landed" — it can
    // just as easily be a submit the gateway accepted, and retrying it would run
    // the prompt twice.
    const { withSessionNotFoundResume } = await sessionRecovery()

    await withSessionNotFoundResume(
      sessionId,
      storedId,
      live => requestGateway('prompt.submit', { session_id: live, text: trimmed }, PROMPT_SUBMIT_TIMEOUT_MS),
      {
        onRecovered: live => {
          rekeySession(submitKey, live, { runtimeSessionId: live })
          submitKey = live
        }
      }
    )
  } catch (err) {
    settleTurn(submitKey, 'error')
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

// ---------------------------------------------------------------------------
// Active-turn correction ("stop and correct").
//
// Steering is not a queue nudge. `session.redirect` cancels the model request
// in place and rebuilds the live turn with the correction folded in, keeping
// the reasoning and completed tool work already on screen; during a tool the
// gateway defers it to the next safe result boundary. The queue is the
// FALLBACK for what redirect cannot take: an attachment, a compacting turn, or
// a runtime that does not support it.
// ---------------------------------------------------------------------------

/**
 * Insert a user message immediately BEFORE the live reply, rather than at the
 * tail.
 *
 * A redirect aborts the model request, so its `message.complete` can race the
 * RPC response. Appending after the response settles would leave the correction
 * sitting underneath a reply the redirect has already replaced.
 */
function insertCorrectionMessage(key: string, text: string): string {
  const id = nextId()

  updateSession(key, state => {
    const messages = state.messages
    const pendingIndex = messages.findIndex(message => message.role === 'assistant' && message.pending)
    const lastAssistantIndex = messages.map(message => message.role).lastIndexOf('assistant')
    const at = pendingIndex >= 0 ? pendingIndex : lastAssistantIndex

    const correction: ChatMessage = { id, role: 'user', parts: [{ type: 'text', text }] }

    return {
      ...state,
      messages: at < 0 ? [...messages, correction] : [...messages.slice(0, at), correction, ...messages.slice(at)]
    }
  })

  return id
}

const dropMessage = (key: string, id: string): void => {
  updateSession(key, state => ({ ...state, messages: state.messages.filter(message => message.id !== id) }))
}

const moveMessageToEnd = (key: string, id: string): void => {
  updateSession(key, state => {
    const message = state.messages.find(candidate => candidate.id === id)

    return message
      ? { ...state, messages: [...state.messages.filter(candidate => candidate.id !== id), message] }
      : state
  })
}

/**
 * Correct the live turn. Resolves true when the gateway took the words —
 * whether as an in-place redirect or as the next turn's prompt — and false when
 * the caller must queue them itself so nothing is lost.
 */
export async function redirectPrompt(rawText: string, key = $activeSessionKey.get()): Promise<boolean> {
  const text = rawText.trim()
  const slice = $sessionStates.get()[key]
  const sessionId = slice?.runtimeSessionId

  if (!text || !sessionId) {
    return false
  }

  const messageId = insertCorrectionMessage(key, text)

  // A recovery hands back a fresh runtime id and the slice moves with it, so
  // everything below addresses the session by the key it currently lives under
  // rather than the one it started on.
  let liveKey = key

  try {
    // Steering is the other RPC that runs against the runtime id, so it fails
    // the same way after a sleep/wake — and it fails QUIETLY, falling back to
    // the composer's local queue, which is why nobody noticed. Recover it like
    // the submit above; a runtime that had to be resumed has no live turn left
    // to fold into, so the gateway answers `queued` and the correction lands at
    // the tail, which is the correct place for it.
    const { withSessionNotFoundResume } = await sessionRecovery()

    const { result } = await withSessionNotFoundResume(
      sessionId,
      slice?.storedSessionId ?? null,
      live => requestGateway<SessionRedirectResponse>('session.redirect', { session_id: live, text }),
      {
        onRecovered: live => {
          rekeySession(liveKey, live, { runtimeSessionId: live })
          liveKey = live
        }
      }
    )

    if (result?.status === 'redirected') {
      // Folded into the live turn — the correction belongs where it was placed,
      // above the reply it is redirecting.
      recordTurnCorrection(liveKey, text)

      return true
    }

    if (result?.status === 'queued') {
      // The turn-build window: the gateway had no agent to redirect yet, so
      // this is the NEXT turn's prompt. It has to sit at the tail, not
      // mid-transcript above a reply it had no part in.
      moveMessageToEnd(liveKey, messageId)
      recordTurnCorrection(liveKey, text)

      return true
    }

    dropMessage(liveKey, messageId)

    return false
  } catch {
    dropMessage(liveKey, messageId)

    return false
  }
}

/**
 * Stop the live turn on ONE session (Esc / the composer's Stop / a user bubble's
 * Stop / a tile's Stop).
 *
 * `session.interrupt` runs against the RUNTIME id, so it is one of the verbs most
 * likely to be holding a dead binding after a sleep/wake — and all three call
 * sites used to swallow the rejection with a bare `.catch(() => {})`. That is why
 * "Stop stopped working after the laptop slept" never surfaced as anything: the
 * control was dead, silently, with no retry (MJXHRM-366).
 *
 * Recovered like every other session-scoped RPC, and a genuine failure raises a
 * toast. Resolves true when the gateway took the interrupt.
 */
export async function interruptSession(key = $activeSessionKey.get()): Promise<boolean> {
  const slice = $sessionStates.get()[key]
  const sessionId = slice?.runtimeSessionId

  if (!sessionId) {
    return false
  }

  // A recovery hands back a fresh runtime id and the slice moves with it.
  let liveKey = key

  try {
    const { withSessionNotFoundResume } = await sessionRecovery()

    const { recovered } = await withSessionNotFoundResume(
      sessionId,
      slice.storedSessionId,
      live => requestGateway('session.interrupt', { session_id: live }),
      {
        onRecovered: live => {
          rekeySession(liveKey, live, { runtimeSessionId: live })
          liveKey = live
        }
      }
    )

    // A RECOVERED interrupt landed on a runtime the gateway minted a moment ago,
    // so the turn this session thought was live died with the runtime that owned
    // it: there is no terminal frame coming to settle it. Without this the chat
    // (or the tile) stayed busy forever behind a Stop button that had already
    // done everything it could — the same shape MJXHRM-366 fixed for the silent
    // rejection, one layer further in.
    //
    // The un-recovered case is deliberately left alone: the gateway is
    // cancelling a turn it genuinely owns, and its `message.complete` is the
    // authority on when that turn is over.
    if (recovered) {
      settleTurn(liveKey)
      updateSession(liveKey, state => ({
        ...state,
        awaitingResponse: false,
        busy: false,
        streamId: null,
        turnStartedAt: null
      }))
    }

    return true
  } catch (err) {
    notifyError(err, translateNow('desktop.stopFailed'))

    return false
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
 * Build `prompt.submit` truncation params. Ordinal 0 truncates to an EMPTY
 * transcript (restoring or editing the first user turn) — the gateway refuses
 * that edge unless `confirm_empty_truncate` is set, so a stale client cannot
 * silently wipe a session with a leftover ordinal. Ported from desktop's
 * `truncateSubmitParams`; universal omitted it, which made a rewind to the very
 * first prompt fail with a 422 that read as "restore is broken".
 */
function truncateSubmitParams(truncateOrdinal: number | undefined): Record<string, unknown> {
  if (truncateOrdinal === undefined) {
    return {}
  }

  return {
    truncate_before_user_ordinal: truncateOrdinal,
    ...(truncateOrdinal === 0 ? { confirm_empty_truncate: true } : {})
  }
}

/**
 * The session a rewind is running against. MUTABLE on purpose: a stale-runtime
 * recovery mid-rewind hands back a fresh runtime id and moves the slice with it,
 * and both the retry below and the caller's rollback have to address the session
 * where it now lives rather than where it started.
 */
interface RewindTarget {
  /** The slice key the transcript lives under. */
  key: string
  /** The wire-facing runtime id. */
  sessionId: string
  /** The durable id a recovery resumes FROM. */
  storedId: null | string
}

/**
 * Rewind a turn: `prompt.submit` with an optional `truncate_before_user_ordinal`
 * (drops that user turn + everything after). Idle rewinds submit directly —
 * interrupting an idle agent can leave a stale interrupt flag that cancels the
 * fresh turn; live turns interrupt first, and a raced "session busy" response
 * interrupts + retries. Ported from desktop's `runRewindSubmit`.
 *
 * Both RPCs run through `withSessionNotFoundResume` (MJXHRM-367). A rewind is
 * the LONGEST-idle submit path in the app — the user reads a reply, thinks, and
 * only then edits or restores — so it is the one most likely to be holding a
 * runtime id the gateway has already dropped, and it was the only submit path
 * left unwrapped.
 */
async function runRewindSubmit(
  target: RewindTarget,
  text: string,
  truncateOrdinal: number | undefined,
  interruptFirst: boolean
): Promise<void> {
  const { withSessionNotFoundResume } = await sessionRecovery()

  const recover = async <T>(call: (liveSessionId: string) => Promise<T>): Promise<T> => {
    const { result } = await withSessionNotFoundResume(target.sessionId, target.storedId, call, {
      onRecovered: live => {
        rekeySession(target.key, live, { runtimeSessionId: live })
        target.key = live
        target.sessionId = live
      }
    })

    return result
  }

  const interrupt = async () => {
    try {
      await recover(live => requestGateway('session.interrupt', { session_id: live }))
    } catch {
      // Best-effort, and deliberately still quiet HERE (unlike `interruptSession`):
      // this interrupt is immediately followed by a submit whose failure IS
      // surfaced, so a toast for the interrupt alone would fire on rewinds that
      // then succeed. The recovery above is the part that was missing.
    }
  }

  const submit = () =>
    recover(live =>
      requestGateway(
        'prompt.submit',
        { session_id: live, text, ...truncateSubmitParams(truncateOrdinal) },
        PROMPT_SUBMIT_TIMEOUT_MS
      )
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

  const target: RewindTarget = {
    key: editKey,
    sessionId,
    storedId: $sessionStates.get()[editKey]?.storedSessionId ?? null
  }

  updateSession(editKey, state => ({
    ...state,
    busy: true,
    turnStartedAt: Date.now(),
    statusLine: '',
    messages: [...messages.slice(0, plan.sourceIndex), plan.editedMessage]
  }))

  try {
    await runRewindSubmit(target, plan.text, plan.truncateOrdinal, wasBusy)
  } catch (err) {
    // The target turn moved under us (e.g. auto-compression rotated the
    // history). We already interrupted, so land the text as a plain resend.
    if (!plan.isFailedTurn && isStaleTargetError(err)) {
      try {
        await runRewindSubmit(target, plan.text, undefined, false)

        return
      } catch {
        // Fall through to the rollback below with the original error.
      }
    }

    // Restore the pre-edit transcript so the UI matches what's persisted
    // instead of stranding a partial timeline. Addressed to `target.key`, which
    // a mid-flight recovery may have moved.
    updateSession(target.key, state => ({
      ...state,
      busy: false,
      turnStartedAt: null,
      statusLine: err instanceof Error ? err.message : String(err),
      messages
    }))
    notifyError(err, translateNow('desktop.editFailed'))
  }
}

/** How the transcript should be rewound to re-run an EXISTING prompt unchanged. */
export interface RestorePlan {
  sourceIndex: number
  text: string
  truncateOrdinal: number
}

/** The nth user turn's index, or -1. The backend truncates by user ordinal, and
 *  universal renders no hidden branch-loser rows, so every user row counts. */
function userIndexAtOrdinal(messages: ChatMessage[], targetOrdinal: number): number {
  let ordinal = 0

  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role !== 'user') {
      continue
    }

    if (ordinal === targetOrdinal) {
      return index
    }

    ordinal += 1
  }

  return -1
}

const userOrdinalAt = (messages: ChatMessage[], end: number): number =>
  messages.slice(0, end).filter(message => message.role === 'user').length

/**
 * Resolve the user turn a restore should rewind to. Throws with a user-facing
 * reason — a destructive action must say why it refused rather than no-op.
 *
 * The id is the primary key and the ordinal the fallback: the transcript can be
 * re-keyed under us between the click and the confirm (an auto-compaction
 * rewrites committed ids), and the ordinal still names the same turn.
 *
 * That precedence has to hold for the TRUNCATION too. `truncateOrdinal` is what
 * the backend rewinds by, so taking the caller's ordinal verbatim let a locator
 * hint overrule the turn the id actually resolved to — and a caller counting
 * against anything but this array (the transcript renders a windowed tail, see
 * `app/chat/transcript-window.ts`) silently truncated a different, earlier turn
 * than the one the client optimistically cut at. Count it here instead: in the
 * fallback case `sourceIndex` IS the ordinal's own index, so nothing is lost.
 *
 * Ported from desktop's `planRestore`.
 */
export function planRestore(
  messages: ChatMessage[],
  messageId: string,
  target?: { text?: string; userOrdinal?: null | number }
): RestorePlan {
  const idIndex = messages.findIndex(message => message.id === messageId && message.role === 'user')

  const fallbackIndex =
    target?.userOrdinal === null || target?.userOrdinal === undefined
      ? -1
      : userIndexAtOrdinal(messages, target.userOrdinal)

  const sourceIndex = idIndex >= 0 ? idIndex : fallbackIndex
  const source = messages[sourceIndex]

  if (!source || source.role !== 'user') {
    throw new Error(translateNow('desktop.restoreMissing'))
  }

  const text = (chatMessageText(source).trim() || target?.text?.trim() || '').trim()

  if (!text) {
    throw new Error(translateNow('desktop.restoreEmpty'))
  }

  return { sourceIndex, text, truncateOrdinal: userOrdinalAt(messages, sourceIndex) }
}

/**
 * Cursor-style "restore checkpoint": rewind the conversation to a past user
 * prompt and run it again from there, unchanged.
 *
 * Shares the edit path's rewind primitive — `prompt.submit` with
 * `truncate_before_user_ordinal` drops that user turn and everything after it,
 * then the same text goes back as a fresh turn. Callers confirm first; errors are
 * rethrown so the confirming surface can surface them.
 */
export async function restoreToMessage(
  messageId: string,
  restoreTarget?: { text?: string; userOrdinal?: null | number },
  restoreKey = $activeSessionKey.get()
): Promise<void> {
  // Addressed by KEY, not by the active-chat projections: a tile's transcript
  // renders the same user bubble, and a rewind is destructive enough that
  // "whichever chat is on screen" is the wrong session to resolve it against.
  const slice = $sessionStates.get()[restoreKey]
  const sessionId = slice?.runtimeSessionId

  if (!sessionId) {
    throw new Error(translateNow('desktop.restoreNoSession'))
  }

  const messages = slice.messages
  const plan = planRestore(messages, messageId, restoreTarget)

  // The turns being discarded belong to an abandoned timeline — same cleanup the
  // edit path does before its re-run repopulates.
  stopSpeaking()
  clearNotifications()
  clearPreviewArtifacts(sessionId)

  const wasBusy = slice.busy

  const target: RewindTarget = {
    key: restoreKey,
    sessionId,
    storedId: slice.storedSessionId
  }

  // The prompt itself stays: it is being re-run, not withdrawn. Everything after
  // it belongs to the abandoned timeline and disappears immediately.
  updateSession(restoreKey, state => ({
    ...state,
    busy: true,
    interrupted: false,
    turnStartedAt: Date.now(),
    statusLine: '',
    messages: messages.slice(0, plan.sourceIndex + 1)
  }))

  try {
    await runRewindSubmit(target, plan.text, plan.truncateOrdinal, wasBusy)
  } catch (err) {
    // The rewind never landed. Roll the optimistic truncation back to the full
    // history so the transcript matches what is persisted — leaving it truncated
    // is what makes every later send look duplicative.
    updateSession(target.key, state => ({
      ...state,
      busy: false,
      turnStartedAt: null,
      statusLine: err instanceof Error ? err.message : String(err),
      messages
    }))

    throw err
  }
}

// The prompt responders answer for ONE session. They default to the active one
// (that is where the composer bars live), but take an explicit key so a tile's
// or a background bubble's bars can answer their own session.
//
// None of them clears optimistically (MJXHRM-418). The backend blocks in
// `_await_gateway_decision()` / `_block()` until the matching `*.respond` lands,
// so a send that fails after the client has already torn the bar down parks the
// agent until its timeout — five minutes for an approval, after which the tool
// is BLOCKED — while the vanishing bar reads to the user as "accepted". Worse,
// the request is gone from `store/prompts.ts`, so there is no way to answer it
// again. `respondClarify` was the local precedent and the other three now follow
// its shape: send first, clear only once the gateway has the answer, and throw
// so the bar can surface the failure and stay answerable.

/**
 * `approval.respond` is the ONE responder the resume wrapper can help.
 *
 * It is the only one of the four the gateway resolves through `_sess()`, so it
 * is the only one that can answer "session not found" — and a parked approval is
 * by construction an old prompt the user has been staring at, which makes it the
 * likeliest verb in the app to be holding a runtime id the gateway dropped under
 * it after a sleep/wake (MJXHRM-366's failure, one method over).
 *
 * `clarify.respond`, `sudo.respond` and `secret.respond` are keyed on
 * `request_id` alone and carry no session at all, so wrapping THEM would be dead
 * code: there is no rejection for the wrapper to catch. See MJXHRM-418's
 * correction comment.
 */
export async function respondApproval(choice: ApprovalChoice, key = $activeSessionKey.get()): Promise<void> {
  const slice = $sessionStates.get()[key]
  // A slice with no runtime id has nothing the gateway can resolve — `_sess()`
  // answers an empty `session_id` with the same "session not found" it gives a
  // dead one, which is exactly what the old swallow was hiding.
  const live = slice?.runtimeSessionId ?? key
  // Lazily, like every other recovery call site here — `store/session-recovery`
  // imports back into the session store (see the note on `sessionRecovery`).
  const { withSessionNotFoundResume } = await sessionRecovery()

  const { recovered, sessionId: recoveredId } = await withSessionNotFoundResume(live, slice?.storedSessionId, id =>
    requestGateway('approval.respond', { choice, session_id: id })
  )

  // A recovery MOVES the slice. The default `onRecovered` rekeys it onto the
  // recovered runtime id, and `store/prompts.ts`'s rekey hook carries the
  // approval request across with it — so clearing the key we started on is a
  // silent no-op: the agent is unblocked, but the bar stays on screen under the
  // new key with nothing left that will ever dismiss it, and every further
  // choice re-answers a request the gateway has already resolved. Same failure
  // shape as MJXHRM-308, one layer above the resolver that fixed it.
  const liveKey = recovered ? recoveredId : key

  // Only drop the request once the gateway has taken the answer.
  clearSessionApproval(liveKey)
  clearAwaitingInputPose(liveKey)
}

/** What the gateway did with a clarify answer. `gone` covers both halves of
 *  "nobody is waiting for this": no local request to answer, and a request the
 *  backend already timed out. */
export type ClarifyRespondOutcome = 'delivered' | 'expired' | 'gone'

/**
 * Answer the pending clarify.
 *
 * Unlike the other prompt responders this does NOT clear optimistically: the
 * inline panel keeps the question on screen and surfaces the error if the send
 * fails, so the user can retry instead of losing the (still-blocked) prompt.
 * Throws on failure.
 *
 * `clarify.respond` is `allow_expired` on the backend (`_respond` in
 * `tui_gateway/server.py`), which means a request the 5-minute timeout already
 * popped answers `{"status": "expired"}` — an RPC SUCCESS that delivered
 * nothing. Reporting that as a normal send is how an answer disappears with the
 * UI saying it went through, so the outcome comes back to the caller.
 */
export async function respondClarify(answer: string, key = $activeSessionKey.get()): Promise<ClarifyRespondOutcome> {
  const req = sessionClarifyRequest(key).get()

  if (!req) {
    return 'gone'
  }

  const result = await requestGateway<{ status?: string }>('clarify.respond', {
    request_id: req.requestId,
    answer
  })

  // Only drop the request once the gateway has it; `tool.complete` lands next
  // and swaps the inline panel to its settled Q&A view. An expired request is
  // equally finished — nothing will ever answer it — so it clears too.
  if (sessionClarifyRequest(key).get()?.requestId === req.requestId) {
    clearSessionClarify(key)
    clearAwaitingInputPose(key)
  }

  return result?.status === 'expired' ? 'expired' : 'delivered'
}

export async function respondSudo(password: string, key = $activeSessionKey.get()): Promise<void> {
  const req = sessionSudoRequest(key).get()

  if (!req) {
    return
  }

  await requestGateway('sudo.respond', { request_id: req.requestId, password })

  // Same guard `respondClarify` uses: a `tool.complete` racing this answer may
  // already have swapped the request out, and clearing then would drop a
  // NEWER prompt that arrived while this one was in flight.
  if (sessionSudoRequest(key).get()?.requestId === req.requestId) {
    clearSessionSudo(key)
    clearAwaitingInputPose(key)
  }
}

export async function respondSecret(value: string, key = $activeSessionKey.get()): Promise<void> {
  const req = sessionSecretRequest(key).get()

  if (!req) {
    return
  }

  await requestGateway('secret.respond', { request_id: req.requestId, value })

  if (sessionSecretRequest(key).get()?.requestId === req.requestId) {
    clearSessionSecret(key)
    clearAwaitingInputPose(key)
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
 *
 * `cwd` anchors the new draft to a specific directory (the "start work" /
 * branch-off hand-off — see `startSessionInWorkspace` in store/session). It is
 * part of the draft's SEED rather than a correction applied afterwards, so
 * `$currentCwd` moves straight from the outgoing chat's directory to the target.
 * Seeding the default and correcting it after publishes the directory in
 * between, which `$currentCwd` subscribers — the file tree, the review pane, the
 * statusbar — then act on. Only callers reached from inside another store's
 * listener escape that, and then only because nanostores coalesces nested
 * writes; see `startSessionInWorkspace` for the path where it bit.
 */
export function resetChat(cwd?: string): void {
  const previousKey = $activeSessionKey.get()
  const draftKey = newDraftKey()

  // Absent an explicit anchor, a fresh chat starts in the configured default
  // project dir (if any), not in whatever directory the chat we just left used.
  ensureSessionSlice(draftKey, { cwd: cwd?.trim() || cwdForNewSession()?.trim() || '' })
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
