import type { GatewayEvent } from '@/gateway'
import { translateNow } from '@/i18n'
import { renderMediaTags } from '@/lib/chat-media'
import { coerceThinkingText } from '@/lib/chat-runtime'
import { type GatewayToolPayload, toolIdFromPayload, upsertToolPart } from '@/lib/chat-tool-parts'
import { playCompletionSound } from '@/lib/completion-sound'
import { resolveGatewayEventSessionId } from '@/lib/gateway-events'
import { triggerHaptic } from '@/lib/haptics'
import { stopSpeaking } from '@/lib/tts'
import { atom, computed } from '@/store/atom'
import { cwdForNewSession } from '@/store/default-project-dir'
import { requestGateway } from '@/store/gateway'
import { dispatchNativeNotification } from '@/store/native-notifications'
import { notifyError } from '@/store/notifications'
import { flashPetActivity, setPetActivity } from '@/store/pet'
import { $subagentsBySession, upsertSubagent } from '@/store/subagents'
import { recordToolDiff } from '@/store/tool-diffs'
import type { ContextBreakdown, SessionCreateResponse, UsageStats } from '@/types/hermes'

// Chat model over the assistant-ui parts vocabulary. The gateway-event reducer
// mutates a plain ChatMessage[] (decoupled from assistant-ui); the runtime
// (app/chat/runtime.tsx) converts these to assistant-ui messages via convertMessage.
//
// Parts are exactly assistant-ui's content-part shapes (text / reasoning /
// tool-call), so conversion is trivial. The streaming reducers are a lean,
// mobile-adapted version of the desktop chat-messages.ts logic — except the
// tool-call reducer, which is now the full desktop port (@/lib/chat-tool-parts).

export type Role = 'assistant' | 'system' | 'user'

export interface TextPart {
  type: 'text'
  text: string
}
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
}
export type ChatPart = ReasoningPart | TextPart | ToolCallPart

export interface ChatMessage {
  id: string
  role: Role
  parts: ChatPart[]
  /** Assistant message is still streaming. */
  pending?: boolean
  error?: string
}

export interface ApprovalRequest {
  command: string
  description: string
  allowPermanent: boolean
}
export interface ClarifyRequest {
  requestId: string
  prompt: string
}
// Sudo is a password-entry flow (not an allow/deny choice).
export interface SudoRequest {
  requestId: string
  prompt: string
}
export interface SecretRequest {
  requestId: string
  envVar: string
  prompt: string
}

export type ApprovalChoice = 'always' | 'deny' | 'once' | 'session'

const PROMPT_SUBMIT_TIMEOUT_MS = 1_800_000

export const $messages = atom<ChatMessage[]>([])
export const $busy = atom(false)

// Primary-session view projections (SessionView shape — PRIMARY_SESSION_VIEW in
// app/chat/session-view.tsx reads these; tiles derive equivalents from their
// own slice). Cheap computeds off $messages/$busy.
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
export const $awaitingResponse = computed(
  [$busy, $lastVisibleMessageIsUser],
  (busy, lastIsUser) => busy && lastIsUser
)

export const $statusLine = atom('')
export const $approval = atom<ApprovalRequest | null>(null)
export const $clarify = atom<ClarifyRequest | null>(null)
export const $sudo = atom<SudoRequest | null>(null)
export const $secret = atom<SecretRequest | null>(null)
export const $sessionId = atom<string | null>(null)

// Live auto-title of the CURRENT runtime session, pushed by the backend's
// `session.title` event (the titler runs async after the first turn). A brand-new
// session isn't in the $sessions list yet and has no $activeStoredSessionId, so
// the chat header can't resolve its title from the list — it reads this instead,
// so the "New session" heading updates on the fly once the title lands.
export const $liveSessionTitle = atom<string>('')

// The ACTIVE chat's working directory — its project directory. Every stored
// session carries one (`SessionInfo.cwd`), so switching chats switches this:
// restored on open/resume (store/session.ts), adopted on create (ensureSession),
// and followed live via `session.info` when the agent relocates itself. Empty
// for a detached chat (no project dir) — consumers should generally read
// `$effectiveCwd` (store/workspace-events), which falls back to the workspace
// root, rather than this raw value.
export const $currentCwd = atom<string>('')

export function setCurrentCwd(cwd: null | string | undefined): void {
  $currentCwd.set(cwd?.trim() || '')
}

// --- Statusbar runtime signals (turn/session timers + live context usage) ---
// Mirrors desktop's session-store $turnStartedAt/$sessionStartedAt/$currentUsage,
// wired here since chat.ts owns the turn lifecycle. The statusbar reads these for
// its running-timer, session-timer, and context-usage items.
const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }
export const $turnStartedAt = atom<number | null>(null)
export const $sessionStartedAt = atom<number | null>(null)
export const $currentUsage = atom<UsageStats>(EMPTY_USAGE)

// Pull the live context breakdown for the bar label after a settled turn. The
// ContextUsagePanel fetches its own breakdown on open; this only feeds the label.
// Best-effort — keep the prior value on failure.
async function refreshCurrentUsage(): Promise<void> {
  const sessionId = $sessionId.get()

  if (!sessionId) {
    return
  }

  try {
    const b = await requestGateway<ContextBreakdown>('session.context_breakdown', { session_id: sessionId })
    $currentUsage.set({
      ...EMPTY_USAGE,
      context_max: b.context_max,
      context_percent: b.context_percent,
      context_used: b.context_used,
      total: b.context_used ?? 0
    })
  } catch {
    /* leave the prior usage in place */
  }
}

let messageCounter = 0
export const nextId = (): string => `m${++messageCounter}-${Date.now()}`

export function coerceText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(coerceText).join('')
  }

  return ''
}

function update(fn: (messages: ChatMessage[]) => ChatMessage[]): void {
  $messages.set(fn($messages.get()))
}

function newAssistant(): ChatMessage {
  return { id: nextId(), role: 'assistant', parts: [], pending: true }
}

export function withActiveAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1]

  if (last && last.role === 'assistant' && last.pending) {
    return messages
  }

  return [...messages, newAssistant()]
}

// See the tool.complete case: lazy to avoid a chat ↔ workspace-events cycle.
async function notifyWorkspaceChangeFromTool(payload: Record<string, unknown>): Promise<void> {
  const { notifyWorkspaceChanged, toolChangedPath, toolMayMutateFiles } = await import('@/store/workspace-events')

  if (toolMayMutateFiles(payload)) {
    notifyWorkspaceChanged(toolChangedPath(payload))
  }
}

export function patchActive(messages: ChatMessage[], patch: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const next = withActiveAssistant(messages)
  const index = next.length - 1
  const copy = next.slice()
  copy[index] = patch(next[index])

  return copy
}

// Append a streaming delta into the tail part when it's the same channel, else
// open a new part.
export function appendStreamPart(parts: ChatPart[], type: 'reasoning' | 'text', delta: string): ChatPart[] {
  if (!delta) {
    return parts
  }

  // Coalesce into the most recent same-type part within the current segment
  // (bounded by non-streaming parts like tool calls). The opposite streaming
  // channel (text<->reasoning) is TRANSPARENT — so a reasoning burst between two
  // content deltas can't shred one sentence into text / Thinking / text.
  // (Ported from desktop lib/chat-messages.ts appendStreamPart.)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]

    if (part.type === type) {
      const copy = parts.slice()
      copy[i] = { type, text: part.text + delta }

      return copy
    }

    if (part.type !== 'text' && part.type !== 'reasoning') {
      break
    }
  }

  return [...parts, { type, text: delta }]
}

// Append an assistant text delta, then rewrite MEDIA: markers in the active text
// part to #media: links so media renders inline as it streams (mirrors desktop
// lib/chat-messages.ts appendAssistantTextPart). Idempotent on already-rendered
// text — the guard skips parts with no MEDIA: literal.
export function appendAssistantTextPart(parts: ChatPart[], delta: string): ChatPart[] {
  const next = appendStreamPart(parts, 'text', delta)

  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i]

    if (part.type === 'text') {
      if (part.text.includes('MEDIA:')) {
        const rendered = renderMediaTags(part.text)

        if (rendered !== part.text) {
          const copy = next.slice()
          copy[i] = { type: 'text', text: rendered }

          return copy
        }
      }

      return next
    }

    // Stay within the current streaming segment (bounded by tool calls etc.).
    if (part.type !== 'reasoning') {
      break
    }
  }

  return next
}

// A settled reasoning burst (`reasoning.available` / `moa.reference`): the FULL
// text of one model step's scratchpad, capped at 500 chars by the gateway
// (agent/conversation_loop.py). A multi-step turn emits one per step, so this
// must never overwrite an earlier step's thinking block — the bug that left only
// the last blocks visible.
//
// Three cases, in order:
//  1. Already streamed via reasoning.delta (the burst is that text, or a capped
//     prefix of it) → drop it, it would be a duplicate "Thinking" block. This is
//     what desktop approximates with its "message already has text → skip" rule.
//  2. The live reasoning block is still open (nothing but reasoning since) →
//     swap in the authoritative full text.
//  3. Prose or a tool call already followed → open a NEW block, preserving the
//     chronology of the turn instead of clobbering the previous step.
export function applySettledReasoning(parts: ChatPart[], text: string): ChatPart[] {
  const settled = text.trim()

  if (!settled) {
    return parts
  }

  if (parts.some(part => part.type === 'reasoning' && part.text.trim().includes(settled))) {
    return parts
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]

    if (part.type === 'reasoning') {
      const copy = parts.slice()
      copy[i] = { type: 'reasoning', text }

      return copy
    }

    // Any prose or tool call closes the previous thinking block.
    break
  }

  return [...parts, { type: 'reasoning', text }]
}

// Route a tool event into the transcript. While a turn is live the parts land on
// the pending assistant; a LATE event (one that arrives after message.complete —
// a trailing completion, a sub-agent mirror) must merge into the last assistant
// instead of opening a fresh `pending: true` bubble that nothing ever settles.
// Desktop gets this from `pending: m => phase !== 'complete' || (m.pending ?? false)`
// in use-message-stream; universal has no per-message patcher, so we branch here.
function applyToolEvent(payload: GatewayToolPayload, phase: 'complete' | 'running'): void {
  update(messages => {
    const last = messages[messages.length - 1]
    const settledAssistant = !$busy.get() && last?.role === 'assistant' && !last.pending

    if (settledAssistant) {
      const copy = messages.slice()
      copy[copy.length - 1] = { ...last, parts: upsertToolPart(last.parts, payload, phase) }

      return copy
    }

    return patchActive(messages, m => ({ ...m, parts: upsertToolPart(m.parts, payload, phase) }))
  })
}

// The session that owns the current unscoped stream — pinned on message.start,
// released on message.complete/error (see lib/gateway-events).
let unscopedStreamSessionId: null | string = null

export function handleGatewayEvent(event: GatewayEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>

  // Which chat does this event belong to? Universal keeps ONE transcript, so an
  // event owned by another session must not be reduced into it (a background
  // turn's tool rows, or the previous turn's tail after a mid-turn chat switch).
  const route = resolveGatewayEventSessionId({
    activeSessionId: $sessionId.get(),
    eventType: event.type,
    explicitSessionId: event.session_id || '',
    unscopedStreamSessionId
  })

  unscopedStreamSessionId = route.nextUnscopedStreamSessionId

  if (route.drop) {
    return
  }

  // Conservative: only reject when BOTH ids are known and disagree, so a gateway
  // that omits session ids behaves exactly as before. `session.title` carries its
  // own stored id (it also patches the sidebar list for other sessions), so it is
  // exempt from the active-session gate.
  const activeSessionId = $sessionId.get()

  if (event.type !== 'session.title' && route.sessionId && activeSessionId && route.sessionId !== activeSessionId) {
    return
  }

  switch (event.type) {
    case 'message.start':
      $busy.set(true)
      $turnStartedAt.set(Date.now())
      $statusLine.set('')
      setPetActivity({ busy: true }) // pet: working pose
      stopSpeaking() // interrupt any TTS from the previous turn
      update(withActiveAssistant)

      break

    case 'message.delta':
      update(messages =>
        patchActive(messages, m => ({ ...m, parts: appendAssistantTextPart(m.parts, coerceText(payload.text)) }))
      )

      break

    case 'reasoning.delta':
      setPetActivity({ reasoning: true }) // pet: thinking pose
      update(messages =>
        patchActive(messages, m => ({
          ...m,
          parts: appendStreamPart(m.parts, 'reasoning', coerceThinkingText(payload.text))
        }))
      )

      break

    case 'reasoning.available':
      setPetActivity({ reasoning: true }) // pet: thinking pose
      update(messages =>
        patchActive(messages, m => ({ ...m, parts: applySettledReasoning(m.parts, coerceThinkingText(payload.text)) }))
      )

      break
    case 'moa.reference': {
      setPetActivity({ reasoning: true }) // pet: thinking pose
      const label = coerceText(payload.label)
      const idx = coerceText(payload.index)
      const total = coerceText(payload.total)
      const header = `◇ Reference ${idx}/${total}${label ? ` — ${label}` : ''}\n`
      // A reference block is its own labelled thinking block — never merged into
      // the neighbouring one (desktop appends it as a settled burst too).
      update(messages =>
        patchActive(messages, m => ({
          ...m,
          parts: [...m.parts, { type: 'reasoning', text: header + coerceThinkingText(payload.text) }]
        }))
      )

      break
    }

    case 'tool.start':

    case 'tool.progress':

    case 'tool.generating':
      setPetActivity({ reasoning: false, toolRunning: true }) // pet: working pose
      applyToolEvent(payload, 'running')

      break
    case 'tool.complete': {
      setPetActivity({ toolRunning: false })
      applyToolEvent(payload, 'complete')
      // Live side-channel diff: the gateway renders the edit diff itself and
      // ships it on tool.complete (server.py `_on_tool_complete`). The renderer
      // prefers this over one parsed out of the result, keyed by the SAME id the
      // part adopted in upsertToolPart.
      const inlineDiff = coerceText(payload.inline_diff)

      if (inlineDiff.trim()) {
        recordToolDiff(toolIdFromPayload(payload), inlineDiff)
      }

      // A file-mutating tool just finished — nudge the git-mirroring surfaces
      // (coding rail, review pane, file tree) to refresh. Event-driven, not
      // polled: fires exactly when the agent touches the tree. (Desktop does the
      // same in use-message-stream/gateway-event.ts.)
      //
      // Imported lazily: store/workspace-events reads $currentCwd from THIS
      // module for $effectiveCwd, so a static import is a cycle that leaves one
      // side undefined at init (it broke the statusbar's $effectiveCwd read).
      if (payload) {
        void notifyWorkspaceChangeFromTool(payload)
      }

      break
    }

    case 'message.complete':
      $busy.set(false)
      $turnStartedAt.set(null)
      $statusLine.set('')
      setPetActivity({ busy: false, reasoning: false, toolRunning: false }) // pet: back to idle/roam
      void refreshCurrentUsage()
      update(messages => messages.map(m => (m.pending ? { ...m, pending: false } : m)))

      // Auto-TTS is driven by `useAutoSpeakReplies` (guarded against a running
      // voice conversation + the shared dedupe cursor). Reading it here too would
      // speak every reply twice during a conversation (MJX-96).

      dispatchNativeNotification({
        kind: 'turnDone',
        title: translateNow('notifications.native.turnDoneTitle'),
        body: translateNow('notifications.native.turnDoneBody'),
        sessionId: $sessionId.get()
      })
      // Turn-end audio cue (gated by $hapticsMuted). Mirrors desktop gateway-event.
      playCompletionSound()

      break

    case 'status.update':
      $statusLine.set(coerceText(payload.status) || coerceText(payload.message) || '')

      break

    case 'approval.request':
      $approval.set({
        command: coerceText(payload.command),
        description: coerceText(payload.description) || 'dangerous command',
        allowPermanent: payload.allow_permanent !== false
      })
      setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)
      void triggerHaptic('warning')
      dispatchNativeNotification({
        kind: 'approval',
        title: translateNow('notifications.native.approvalTitle'),
        body: coerceText(payload.command) || coerceText(payload.description),
        sessionId: $sessionId.get()
      })

      break

    case 'clarify.request':
      $clarify.set({
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })
      setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)

      break

    case 'sudo.request':
      $sudo.set({
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.command) || 'Enter your sudo password'
      })
      setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)

      break

    case 'secret.request':
      $secret.set({
        requestId: coerceText(payload.request_id),
        envVar: coerceText(payload.env_var),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })
      setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)

      break

    case 'error':
      $busy.set(false)
      $turnStartedAt.set(null)
      $statusLine.set(coerceText(payload.message) || 'Something went wrong')
      // pet: crying pose, auto-decaying back to normal after 5s.
      setPetActivity({ busy: false, reasoning: false, toolRunning: false })
      flashPetActivity({ error: true }, 5000)
      update(messages =>
        messages.map(m => (m.pending ? { ...m, pending: false, error: coerceText(payload.message) } : m))
      )
      dispatchNativeNotification({
        kind: 'turnError',
        title: translateNow('notifications.native.turnErrorTitle'),
        body: coerceText(payload.message),
        sessionId: $sessionId.get()
      })

      break
    case 'session.title': {
      // Live auto-title push (titler runs async, after the turn). Update the
      // current session's live title so the chat header reflects it on the fly,
      // and patch the sidebar list entry if it's already loaded (decoupled via a
      // dynamic import — store/session imports store/chat, so a static import
      // here would cycle).
      const sid = coerceText(payload.session_id)
      const title = coerceText(payload.title).trim()

      if (title && (!sid || sid === $sessionId.get())) {
        $liveSessionTitle.set(title)
      }

      if (sid && title) {
        void import('@/store/session')
          .then(m => m.setSessions(prev => prev.map(s => (s.id === sid ? { ...s, title } : s))))
          .catch(() => {})
      }

      break
    }

    case 'session.info': {
      // Runtime info for a session. The active chat's agent can relocate itself
      // (entering another repo/worktree via the terminal), so follow its cwd.
      // Apply a session-scoped event only when it targets the active chat; a
      // global broadcast (no session id) only when no chat is open — otherwise a
      // background session would yank the directory out from under the user.
      const eventSessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
      const activeSessionId = $sessionId.get()
      const applies = eventSessionId ? eventSessionId === activeSessionId : !activeSessionId

      // Truthiness-gated (desktop parity): an empty cwd means "unknown", not
      // "detach the current one".
      if (applies && typeof payload.cwd === 'string' && payload.cwd) {
        setCurrentCwd(payload.cwd)
      }

      break
    }

    default:
      // Subagent lifecycle (spawn/start/thinking/tool/progress/complete) feeds
      // the Agents view's spawn tree, keyed by the active runtime session.
      if (event.type.startsWith('subagent.')) {
        const sid = $sessionId.get() ?? 'active'
        const createIfMissing = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'
        upsertSubagent(sid, payload, createIfMissing, event.type)
      }

      // gateway.ready, session.info, thinking.delta, moa.aggregating handled elsewhere.
      // FIXME(G): richer status/session handling.
      break
  }
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

  const created = await requestGateway<SessionCreateResponse>('session.create', {
    cols: 96,
    ...(cwd && { cwd })
  })

  const id = created.session_id
  $sessionId.set(id)
  // Adopt the runtime's resolved working directory — it normalizes (or defaults)
  // whatever cwd we asked for, so this is the value the agent will actually run
  // in, and what the new chat's stored row should be seeded with.
  setCurrentCwd(created.info?.cwd ?? cwd)
  // Runtime session clock starts when we create the session (statusbar session
  // timer). Resumed/loaded sessions have no reliable start on this client, so
  // the timer stays hidden for them.
  $sessionStartedAt.set(Date.now())

  return { id, storedId: created.stored_session_id ?? id }
}

export async function sendPrompt(text: string): Promise<void> {
  const trimmed = text.trim()

  if (!trimmed || $busy.get()) {
    return
  }

  stopSpeaking() // silence any TTS when the user sends a new prompt

  update(messages => [...messages, { id: nextId(), role: 'user', parts: [{ type: 'text', text: trimmed }] }])
  $busy.set(true)
  $turnStartedAt.set(Date.now())
  $statusLine.set('')
  setPetActivity({ busy: true }) // pet: start working the moment the user sends

  try {
    const wasNew = !$sessionId.get()
    const { id: sessionId, storedId } = await ensureSession()

    if (wasNew) {
      // New chat: optimistically add it to the sidebar list + mark active, keyed
      // on the STORED id (what the list refresh + session.title use), with the
      // first message as the provisional title (preview). Dynamic import —
      // store/session imports store/chat, so a static import here would cycle.
      void import('@/store/session').then(m => m.registerNewSession(storedId, trimmed)).catch(() => {})
    }

    await requestGateway('prompt.submit', { session_id: sessionId, text: trimmed }, PROMPT_SUBMIT_TIMEOUT_MS)
  } catch (err) {
    $busy.set(false)
    $turnStartedAt.set(null)
    $statusLine.set(err instanceof Error ? err.message : String(err))
    setPetActivity({ busy: false, reasoning: false, toolRunning: false })
    notifyError(err, 'Message failed to send')
  }
}

export async function respondApproval(choice: ApprovalChoice): Promise<void> {
  const sessionId = $sessionId.get()
  $approval.set(null)
  setPetActivity({ awaitingInput: false })

  try {
    await requestGateway('approval.respond', { choice, session_id: sessionId ?? undefined })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondClarify(answer: string): Promise<void> {
  const req = $clarify.get()
  $clarify.set(null)
  setPetActivity({ awaitingInput: false })

  if (!req) {
    return
  }

  try {
    await requestGateway('clarify.respond', { request_id: req.requestId, answer })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondSudo(password: string): Promise<void> {
  const req = $sudo.get()
  $sudo.set(null)
  setPetActivity({ awaitingInput: false })

  if (!req) {
    return
  }

  try {
    await requestGateway('sudo.respond', { request_id: req.requestId, password })
  } catch {
    /* turn may have moved on */
  }
}

export async function respondSecret(value: string): Promise<void> {
  const req = $secret.get()
  $secret.set(null)
  setPetActivity({ awaitingInput: false })

  if (!req) {
    return
  }

  try {
    await requestGateway('secret.respond', { request_id: req.requestId, value })
  } catch {
    /* turn may have moved on */
  }
}

export function resetChat(): void {
  $messages.set([])
  $sessionId.set(null)
  // A fresh chat starts in the configured default project dir (if any), not in
  // whatever directory the chat we just left happened to use.
  setCurrentCwd(cwdForNewSession())
  $liveSessionTitle.set('')
  $busy.set(false)
  $turnStartedAt.set(null)
  $sessionStartedAt.set(null)
  $currentUsage.set(EMPTY_USAGE)
  $statusLine.set('')
  $approval.set(null)
  $clarify.set(null)
  $sudo.set(null)
  $secret.set(null)
  $subagentsBySession.set({})
  setPetActivity({}) // pet: clear any stale activity on chat teardown
  stopSpeaking()
}
