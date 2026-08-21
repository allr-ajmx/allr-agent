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
import {
  isVoicePlaybackActive,
  markVoicePlaybackInterrupted,
  stopVoicePlayback,
  takeVoicePlaybackInterrupted
} from '@/lib/voice-playback'
import { atom, computed } from '@/store/atom'
import { requestGateway } from '@/store/gateway'
import { clearNotifications, notifyError } from '@/store/notifications'
import { setPetActivity } from '@/store/pet'
import { clearPreviewArtifacts } from '@/store/preview-status'
import { $activeProfile } from '@/store/profiles'
import { resolveNewSessionCwd } from '@/store/project-scope'
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
  runtimeKeyForStoredSession,
  updateSession
} from '@/store/session-state-types'
import { clearSessionSubagents } from '@/store/subagents'
import { beginTurn, getInflightTurn, recordTurnCorrection, settleTurn } from '@/store/turn-lifecycle'
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
  // lives), so it is meaningful remotely too. Otherwise the sidebar's project
  // scope decides — its repo root inside a project, the configured default
  // project dir outside one, nothing at all in the Home bucket — and the gateway
  // resolves its own default cwd if that comes back empty (desktop parity, see
  // `createBackendSessionForSend`).
  //
  // This must be the SAME resolver `resetChat` used to seed the draft, or the
  // detached Home branch dies here instead: an empty slice cwd re-attached the
  // configured default at send time, which is what MJXHRM-393's first pass
  // shipped.
  const cwd = $currentCwd.get().trim() || resolveNewSessionCwd()
  const draftKey = $activeSessionKey.get()

  // The gateway resolves an OMITTED profile to its launch profile, so on a
  // shared remote/cloud gateway every new chat landed on "default" whatever the
  // rail showed (desktop's #45057, never ported). Branch/resume already pass it;
  // this is the one path that did not.
  const profile = $activeProfile.get()

  const created = await requestGateway<SessionCreateResponse>('session.create', {
    cols: 96,
    source: 'universal',
    ...(cwd && { cwd }),
    ...(profile ? { profile } : {})
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

  // Typing barge-in: a new prompt silences the reply being read aloud. When
  // something WAS playing, that is an interruption the model has to hear about,
  // so latch it before the stop clears the state that proves it (MJXHRM-389).
  // The voice loop latches at its own site instead — it cuts playback the
  // instant the user speaks, long before the transcript reaches this function.
  if (isVoicePlaybackActive()) {
    markVoicePlaybackInterrupted()
  }

  // `stopVoicePlayback`, not the bare `stopSpeaking` this used to call: it is
  // the same stop PLUS the per-message state reset. Leaving that reset to the
  // `$ttsSpeaking` subscription means the app's idea of what is playing only
  // clears if the engine happens to publish a falling edge — and a submit that
  // silences a reply must leave "nothing is playing" true either way, or the
  // NEXT submit inherits this one's interruption.
  stopVoicePlayback()

  // Consumed once per submit, whichever path latched it. `interrupted: true`
  // makes the gateway annotate this turn's MODEL message with the cut-off note
  // (`mark_speech_interrupted`, tui_gateway/methods_prompt.py:105-110) — never
  // the persisted text. Omitted entirely when false, so a backend that predates
  // the flag sees exactly the params it always did.
  const interrupted = takeVoicePlaybackInterrupted()

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
  const turn = beginTurn(startKey, { prompt: trimmed })
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

    // Stop, pressed while the session was still being created. `sendPrompt` goes
    // busy before `ensureSession` returns, so the composer offers Stop for the
    // whole `session.create` round trip — and a draft has no runtime id for
    // `interruptSession` to address, which is why all it can do is settle the
    // turn (`interruptUnboundSession`). Reading that back HERE is what makes the
    // press mean something: the prompt is abandoned before it goes out, instead
    // of being sent to a gateway that will then stream a reply into a chat the
    // user has already stopped.
    const open = getInflightTurn(submitKey)

    if (!open || open.turnId !== turn.turnId || open.phase === 'settled') {
      return
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
      live =>
        requestGateway(
          'prompt.submit',
          { session_id: live, text: trimmed, ...(interrupted && { interrupted: true }) },
          PROMPT_SUBMIT_TIMEOUT_MS
        ),
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

/** Prefix `components/assistant-ui/thread/system-message.tsx` renders as the
 *  "steer missed" note. Kept beside the producer so the two cannot drift. */
export const MISSED_STEER_NOTE = 'steer-missed:'

/**
 * A correction the gateway ACCEPTED and then never delivered.
 *
 * `session.redirect` answering `steered` means "a tool is running, the words
 * ride on its result". If the turn ends before another tool batch runs there is
 * no result left to ride on: the gateway hands the text back and requeues it as
 * a whole new turn (`server.py`, `result["pending_steer"]`). Nothing is lost —
 * but the correction bubble is sitting ABOVE a reply it never reached, so the
 * transcript claims an influence that did not happen.
 *
 * Move it to the tail, where the turn that WILL answer it begins, and say so.
 * Matched by text because the gateway names the words, not our message id — and
 * a steer issued from somewhere with no optimistic bubble (`/steer`, a busy
 * submit) simply leaves the note.
 */
export function noteMissedSteer(key: string, rawText: string): void {
  const text = rawText.trim()

  if (!text || !key) {
    return
  }

  updateSession(key, state => {
    // `findLastIndex` is ES2023 and this project's lib target predates it.
    let at = -1

    for (let i = state.messages.length - 1; at < 0 && i >= 0; i -= 1) {
      if (state.messages[i].role === 'user' && chatMessageText(state.messages[i]).trim() === text) {
        at = i
      }
    }

    const note: ChatMessage = {
      id: nextId(),
      parts: [{ type: 'text', text: `${MISSED_STEER_NOTE}${text}` }],
      role: 'system'
    }

    if (at < 0) {
      return { ...state, messages: [...state.messages, note] }
    }

    return {
      ...state,
      messages: [...state.messages.slice(0, at), ...state.messages.slice(at + 1), state.messages[at], note]
    }
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

    if (result?.status === 'redirected' || result?.status === 'steered') {
      // `redirected`: folded into the live turn — the correction belongs where
      // it was placed, above the reply it is replacing.
      //
      // `steered`: a TOOL was running, so the gateway deferred the words to the
      // next tool-result boundary instead of killing it. The same turn still
      // answers them, so the bubble stays where it is — but this branch has to
      // EXIST, because an unrecognised status falls through to `dropMessage`
      // and hands the text back to the composer's queue, which would deliver
      // the same correction twice: once as the deferred steer, once as a whole
      // new turn. When a deferred steer never gets its boundary the gateway
      // pushes `steer.missed`, and `noteMissedSteer` moves the bubble to the
      // tail where the requeued turn will answer it.
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
    return interruptUnboundSession(key, slice)
  }

  // A recovery hands back a fresh runtime id and the slice moves with it.
  let liveKey = key

  try {
    const { withSessionNotFoundResume } = await sessionRecovery()

    const { recovered, result } = await withSessionNotFoundResume<InterruptResult>(
      sessionId,
      slice.storedSessionId,
      live => requestGateway<InterruptResult>('session.interrupt', { session_id: live }),
      {
        onRecovered: live => {
          rekeySession(liveKey, live, { runtimeSessionId: live })
          liveKey = live
        }
      }
    )

    // TWO ways to learn the turn cannot still be running, and both have to
    // settle it here — nothing else will.
    //
    //  - `recovered`: the interrupt landed on a runtime the gateway minted a
    //    moment ago, so the turn this session thought was live died with the
    //    runtime that owned it.
    //  - `was_running === false`: the gateway took the interrupt and told us
    //    there was no live turn under it. That is the desync a lost terminal
    //    frame leaves behind — the reply finished on a socket that went away.
    //    The gateway answered `{"status": "interrupted"}` either way until
    //    MJXHRM-366, so Stop reported success, the client kept waiting for a
    //    `message.complete` that was never coming, and the chat (or the tile)
    //    span forever behind a control that had already done everything it
    //    could. An older gateway omits the field, which reads as `undefined` and
    //    keeps the pre-existing behaviour rather than guessing.
    //
    // A LIVE turn is deliberately left alone: the gateway is cancelling a turn
    // it genuinely owns, and its `message.complete` is the authority on when
    // that turn is over. Ordering makes that safe — `prompt.submit` flips
    // `running` inside its own handler, and both RPCs ride the same ordered
    // socket, so a submit this client has already sent is always visible to the
    // interrupt that follows it.
    if (recovered || result?.was_running === false) {
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

/** What `session.interrupt` answers. `was_running` is the gateway's own record
 *  of whether there was a turn to stop; absent on a gateway older than
 *  MJXHRM-366. */
interface InterruptResult {
  status?: string
  was_running?: boolean
}

/** How long a Stop pressed during a hydrate waits for the binding it needs. */
const STOP_BINDING_TIMEOUT_MS = 20_000

/** Stored id → the Stop already waiting on its binding, so holding the key down
 *  during a slow open cannot queue N interrupts (or N failure toasts). */
const pendingUnboundStops = new Map<string, Promise<boolean>>()

/**
 * Stop on a session with no wire id yet — which is a state the user can very
 * much see, because both of them paint `busy: true`:
 *
 *  - A HYDRATE in flight. `hydrateColdSession` / the tile delegate seed the
 *    `hydrating:<storedId>` slice busy and only bind a runtime id when
 *    `session.resume` returns, so opening any session shows a Stop button for
 *    the whole transcript-fetch + resume round trip — and the session being
 *    opened may genuinely be mid-turn. Wait for the binding and interrupt it.
 *  - A DRAFT mid-`session.create`. `sendPrompt` goes busy and opens the turn
 *    before `ensureSession` returns, so Stop between Enter and the created
 *    session is Stop before the first token. There is no runtime to ask, but the
 *    submit has not left either: settling the turn is what `sendPrompt` reads to
 *    abandon it, so the prompt is never sent.
 *
 * Both used to `return false` here, silently — no RPC, no recovery, no toast.
 * That is MJXHRM-366's own symptom (Stop does nothing, says nothing) entering
 * through the door iteration 31 reported on `invalidateRuntimeBindings`, which
 * MJXHRM-358 has since closed.
 */
async function interruptUnboundSession(key: string, slice: ClientSessionState | undefined): Promise<boolean> {
  const turn = getInflightTurn(key)

  if (turn && turn.phase !== 'settled') {
    settleTurn(key)
    updateSession(key, state => ({
      ...state,
      awaitingResponse: false,
      busy: false,
      interrupted: true,
      streamId: null,
      turnStartedAt: null
    }))

    return true
  }

  const storedId = slice?.storedSessionId

  if (!storedId) {
    // An idle draft: nothing exists anywhere to stop, and no surface offers Stop
    // for it (the control follows `busy`).
    return false
  }

  const existing = pendingUnboundStops.get(storedId)

  if (existing) {
    return existing
  }

  const pending = waitForRuntimeBinding(storedId).then(bound => {
    if (!bound) {
      notifyError(new Error(`Session ${storedId} never bound a runtime`), translateNow('desktop.stopFailed'))

      return false
    }

    return interruptSession(bound)
  })

  pendingUnboundStops.set(storedId, pending)

  return pending.finally(() => pendingUnboundStops.delete(storedId))
}

/** Resolve once `storedId`'s slice carries a runtime id, or null on timeout. */
function waitForRuntimeBinding(storedId: string, timeoutMs = STOP_BINDING_TIMEOUT_MS): Promise<null | string> {
  const bound = (): null | string => {
    const key = runtimeKeyForStoredSession(storedId)

    return key && $sessionStates.get()[key]?.runtimeSessionId ? key : null
  }

  const immediate = bound()

  if (immediate) {
    return Promise.resolve(immediate)
  }

  return new Promise(resolve => {
    let settled = false

    const finish = (value: null | string) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    const unsubscribe = $sessionStates.listen(() => {
      const key = bound()

      if (key) {
        finish(key)
      }
    })
  })
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

// A rewind interrupts the live turn and submits straight after, but
// `session.interrupt` returns BEFORE the provider actually stops — a
// non-interruptible tool keeps running to its next boundary. The gateway refuses
// to fold a truncating submit into its busy path (it would steer the text into
// the very turn being discarded, or queue it with the truncation dropped), so
// that window answers "session busy". Wait it out rather than failing the rewind
// on the first bounce; bounded so a genuinely stuck turn still surfaces.
// Desktop's `withSessionBusyRetry` (use-prompt-actions/utils.ts), same numbers.
const SESSION_BUSY_RETRY_TIMEOUT_MS = 6_000
const SESSION_BUSY_RETRY_INTERVAL_MS = 150

async function withSessionBusyRetry<T>(call: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SESSION_BUSY_RETRY_TIMEOUT_MS

  for (;;) {
    try {
      return await call()
    } catch (err) {
      if (!isSessionBusyError(err) || Date.now() >= deadline) {
        throw err
      }

      await new Promise(resolve => setTimeout(resolve, SESSION_BUSY_RETRY_INTERVAL_MS))
    }
  }
}

const isStaleTargetError = (error: unknown): boolean =>
  /no longer in session history|not in session history/i.test(error instanceof Error ? error.message : String(error))

/**
 * Build `prompt.submit` truncation params.
 *
 * `confirm_truncate` says THIS submit really is a rewind. An ordinal alone is
 * not consent: a client carrying a leftover ordinal into an ordinary send emits
 * a request that is indistinguishable, field by field, from a real rewind, and
 * the cut is a destructive `replace_messages()` — so `methods_prompt.py` refuses
 * any ordinal that does not carry the flag (4029). Universal ported the
 * `confirm_empty_truncate` half of desktop's `truncateSubmitParams` and dropped
 * this one, which meant EVERY rewind — every edit-and-resend, every restore
 * checkpoint — was refused by the gateway and rolled back under an "Edit failed"
 * toast. The feature could not work at all.
 *
 * Ordinal 0 additionally truncates to an EMPTY transcript (restoring or editing
 * the first user turn), which the gateway gates behind its own second opt-in.
 */
function truncateSubmitParams(truncateOrdinal: number | undefined): Record<string, unknown> {
  if (truncateOrdinal === undefined) {
    return {}
  }

  return {
    confirm_truncate: true,
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
 * interrupts again and waits the turn out (`withSessionBusyRetry`). That wait is
 * load-bearing rather than defensive: `session.interrupt` returns before the
 * provider stops, and the gateway refuses to fold a truncating submit into its
 * busy path precisely so the rewind cannot land as a steer or a queued prompt
 * with the truncation silently dropped. Ported from desktop's `runRewindSubmit`.
 *
 * Both RPCs run through `withSessionNotFoundResume` (MJXHRM-367). A rewind is
 * the LONGEST-idle submit path in the app — the user reads a reply, thinks, and
 * only then edits or restores — so it is the one most likely to be holding a
 * runtime id the gateway has already dropped, and it was the only submit path
 * left unwrapped.
 *
 * It also opens the IN-FLIGHT TURN, which `sendPrompt` and the tile delegate
 * both do at submit time and this path did not. The record is what a reconnect
 * reconciles against: with no local turn, `planTurnReconciliation` answers
 * `noop` for a gateway that reports idle, and `applyReconciledBusy` returns
 * without touching the slice — so a rewind whose terminal frame died in the
 * disconnect window left the session `busy: true` for good, spinning behind a
 * transcript it had already truncated. Every failure path settles it again,
 * for the same reason `sendPrompt` does: a live record nothing can settle is
 * the same wedge from the other side.
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

  // AFTER the interrupt: the turn being interrupted is the one this rewind
  // exists to discard, and opening the new record first would hand the old
  // turn's terminal frame a record that outlived it.
  beginTurn(target.key, { prompt: text })

  try {
    try {
      await submit()
    } catch (err) {
      if (!isSessionBusyError(err)) {
        throw err
      }

      await interrupt()
      await withSessionBusyRetry(submit)
    }
  } catch (err) {
    // Nothing is running: the caller is about to roll its optimistic truncation
    // back, and a record left open here would make the next reconnect adopt a
    // turn that never started.
    settleTurn(target.key, 'error')

    throw err
  }
}

/**
 * Send an edited prompt: rewind the transcript to that turn and re-run it with
 * the new text. Optimistically truncates everything after the edited message so
 * the abandoned replies disappear immediately, and rolls the whole transcript
 * back if the gateway rejects. Ported from desktop's `editMessage`.
 *
 * Addressed BY KEY, like every other session verb in this store (`interruptSession`,
 * `redirectPrompt`, `restoreToMessage`, the four responders). Every user bubble
 * in the app is an edit trigger — `UserMessage` sits behind an
 * `ActionBarPrimitive.Edit`, and a session TILE mounts the same `ChatScreen`
 * (`app/chat/session-tile.tsx`) — but this one read the ACTIVE chat's transcript
 * and runtime id instead of the surface's own. Editing a bubble in a tile
 * therefore rewound the main pane. Not merely the wrong target: hydrated message
 * ids are positional (`h${index}-${role}` in `lib/session-history.ts`), so the
 * tile's `h4-user` RESOLVES against the main pane's transcript, and the edit
 * truncated a different conversation at that index and re-ran the tile's text
 * there — a destructive `replace_messages()` on a session the user was not even
 * editing. Desktop keeps the two apart by giving tiles their own action hook
 * (`session-tile-actions.ts`); universal serves both from one component tree, so
 * the key has to travel with the call.
 */
export async function submitEditedPrompt(
  sourceId: string,
  rawText: string,
  editKey = $activeSessionKey.get()
): Promise<void> {
  const slice = $sessionStates.get()[editKey]
  const sessionId = slice?.runtimeSessionId
  const messages = slice?.messages ?? EMPTY_MESSAGES
  const plan = sessionId ? planEdit(messages, sourceId, rawText) : null

  if (!sessionId) {
    return
  }

  if (!plan) {
    // A no-op edit (same text) or a non-user target is nothing to report. A
    // source id that does not resolve is: the user typed a replacement, pressed
    // Enter, and the words are gone with the editor. That happens when an
    // auto-compaction re-keys the transcript under an open editor — the same
    // drift `planRestore` carries an ordinal fallback for.
    if (!messages.some(message => message.id === sourceId)) {
      notifyError(new Error(translateNow('desktop.restoreMissing')), translateNow('desktop.editFailed'))
    }

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

  // This session's busy, not the visible chat's — a tile edit read the main
  // pane's `$busy` and either interrupted a turn nobody asked it to or skipped
  // the interrupt its own live turn needed.
  const wasBusy = Boolean(slice.busy)

  const target: RewindTarget = {
    key: editKey,
    sessionId,
    storedId: slice.storedSessionId
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
        // Put the FULL transcript back first. The gateway refuses an
        // out-of-range ordinal (4018) BEFORE it truncates anything, so nothing
        // was cut — and a plain resend appends at the tail of the history the
        // backend still holds. Leaving the optimistic truncation up would show a
        // thread the backend does not have, with the resent turn grafted onto a
        // cut that never happened: invisible until the next hydration, at which
        // point the "deleted" turns all come back and the edit reads as a
        // duplicate. The edited text goes back on as a NEW row, which is exactly
        // where the gateway is about to persist it (fresh id — the original row
        // is back in place under `sourceId`).
        updateSession(target.key, state => ({
          ...state,
          messages: [...messages, { ...plan.editedMessage, id: nextId() }]
        }))

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
//
// A REJECTION is only half of "the gateway did not take this answer" (MJXHRM-418
// second pass). Every one of these RPCs also has a SUCCESS that delivers
// nothing, and each responder has to read the reply to tell the two apart:
//
//  - `sudo.respond` / `secret.respond` / `clarify.respond` are `allow_expired`
//    (`_respond` in `tui_gateway/server.py`), so an answer that arrives after the
//    tool's own wait gave up returns `{"status": "expired"}` — HTTP-200 shaped,
//    delivered nowhere.
//  - `approval.respond` returns `{"resolved": N}` from
//    `tools/approval.resolve_gateway_approval`, the COUNT of parked agent threads
//    it unblocked. `N === 0` means the queue was already empty: the five-minute
//    approval timeout popped it (`_await_gateway_decision`'s `_drop_entry`), a
//    `/stop` released it, another surface answered it, or the recovery retry
//    landed on a gateway that no longer has the thread. The command was BLOCKED.
//
// Reporting either of those as a normal send is the same lie the swallowed
// rejection was, so the outcome comes back to the caller and the bars say so.

/** What the gateway did with a blocking-prompt answer.
 *
 *  - `delivered` — a waiter took it.
 *  - `expired` — the RPC succeeded and nothing was waiting; the tool has already
 *    given up, so the answer changed nothing. NOT retryable.
 *  - `gone` — there was no local request to answer in the first place. */
export type PromptRespondOutcome = 'delivered' | 'expired' | 'gone'

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
 *
 * Returns `expired` when the gateway resolved NOTHING (`{"resolved": 0}`): the
 * approval the bar is showing is no longer parked anywhere, so the tool it was
 * guarding has already been BLOCKED and this choice changed nothing. The
 * recovery retry above is one of the ways to get there — a resume mints a fresh
 * runtime, and if the gateway process is the thing that died, the thread that
 * was waiting on the queue died with it.
 */
export async function respondApproval(
  choice: ApprovalChoice,
  key = $activeSessionKey.get()
): Promise<PromptRespondOutcome> {
  const slice = $sessionStates.get()[key]
  // A slice with no runtime id has nothing the gateway can resolve — `_sess()`
  // answers an empty `session_id` with the same "session not found" it gives a
  // dead one, which is exactly what the old swallow was hiding.
  const live = slice?.runtimeSessionId ?? key
  // Lazily, like every other recovery call site here — `store/session-recovery`
  // imports back into the session store (see the note on `sessionRecovery`).
  const { withSessionNotFoundResume } = await sessionRecovery()

  const {
    recovered,
    result,
    sessionId: recoveredId
  } = await withSessionNotFoundResume(live, slice?.storedSessionId, id =>
    requestGateway<{ resolved?: number }>('approval.respond', { choice, session_id: id })
  )

  // A recovery MOVES the slice. The default `onRecovered` rekeys it onto the
  // recovered runtime id, and `store/prompts.ts`'s rekey hook carries the
  // approval request across with it — so clearing the key we started on is a
  // silent no-op: the agent is unblocked, but the bar stays on screen under the
  // new key with nothing left that will ever dismiss it, and every further
  // choice re-answers a request the gateway has already resolved. Same failure
  // shape as MJXHRM-308, one layer above the resolver that fixed it.
  const liveKey = recovered ? recoveredId : key

  // Only drop the request once the gateway has taken the answer. An approval it
  // resolved nothing for is equally finished — the tool stopped waiting — so the
  // dead bar goes too, and the outcome tells the caller to SAY so.
  clearSessionApproval(liveKey)
  clearAwaitingInputPose(liveKey)

  // A gateway that omits `resolved` is not claiming anything either way; only an
  // explicit zero means "nobody was waiting". Treating a missing field as
  // expired would turn every older backend into a permanent false warning.
  return result?.resolved === 0 ? 'expired' : 'delivered'
}

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
export async function respondClarify(answer: string, key = $activeSessionKey.get()): Promise<PromptRespondOutcome> {
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

/**
 * Answer the pending sudo password prompt.
 *
 * `sudo.respond` is `allow_expired`, so a password sent after the tool's own
 * wait gave up answers `{"status": "expired"}` — a success that delivered
 * nothing and left the command cancelled. The caller gets that back so the bar
 * can say the password went nowhere instead of vanishing like it worked.
 */
export async function respondSudo(password: string, key = $activeSessionKey.get()): Promise<PromptRespondOutcome> {
  const req = sessionSudoRequest(key).get()

  if (!req) {
    return 'gone'
  }

  const result = await requestGateway<{ status?: string }>('sudo.respond', {
    request_id: req.requestId,
    password
  })

  // Same guard `respondClarify` uses: a `tool.complete` racing this answer may
  // already have swapped the request out, and clearing then would drop a
  // NEWER prompt that arrived while this one was in flight.
  if (sessionSudoRequest(key).get()?.requestId === req.requestId) {
    clearSessionSudo(key)
    clearAwaitingInputPose(key)
  }

  return result?.status === 'expired' ? 'expired' : 'delivered'
}

/** Answer the pending secret prompt. `expired` for the same reason as
 *  `respondSudo`: `secret.respond` is `allow_expired` too. */
export async function respondSecret(value: string, key = $activeSessionKey.get()): Promise<PromptRespondOutcome> {
  const req = sessionSecretRequest(key).get()

  if (!req) {
    return 'gone'
  }

  const result = await requestGateway<{ status?: string }>('secret.respond', {
    request_id: req.requestId,
    value
  })

  if (sessionSecretRequest(key).get()?.requestId === req.requestId) {
    clearSessionSecret(key)
    clearAwaitingInputPose(key)
  }

  return result?.status === 'expired' ? 'expired' : 'delivered'
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

  // Absent an explicit anchor, the SIDEBAR'S PROJECT SCOPE decides — never
  // whatever directory the chat we just left used.
  //
  // THE CHOKE POINT (MJXHRM-393). Every fresh draft in the app arrives here:
  // ⌘N, ⌘T, `/new`, the rail's New session row, the mobile bubble strip's new
  // chat, the fresh chat left behind by deleting or archiving the active
  // session, and a tile window re-homed onto a gateway that has never heard of
  // the chat it was pinned to. Resolving the scope at the CALL SITES instead
  // meant each of them had to remember, and only two ever did — which is the
  // whole shape of this ticket. Desktop resolves it in the one place too
  // (`startFreshSessionDraft`).
  ensureSessionSlice(draftKey, { cwd: cwd?.trim() || resolveNewSessionCwd() })
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
