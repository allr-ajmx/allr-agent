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
import { clearNotifications, notifyError } from '@/store/notifications'
import { clearPreviewArtifacts } from '@/store/preview-status'
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
  // Gateway-restricted choice set (e.g. a tirith warning drops `always`), and the
  // smart-deny flag that implies `['once', 'deny']`. Both optional — the backend
  // omits them on a plain approval. Mirrors desktop's ApprovalRequest.
  choices?: string[]
  smartDenied?: boolean
}
export interface ClarifyRequest {
  requestId: string
  question: string
  // Up to 4 predefined answers (tools/clarify_tool.py); null for an open-ended
  // question. The inline ClarifyTool reads BOTH fields from here — `tool.start`
  // ships no args, so the event payload is the only source for the panel.
  choices: string[] | null
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
// Rotates the empty-state tagline (components/chat/intro.tsx): bumped on every
// new chat so a fresh thread greets differently. Desktop's $introSeed, set from
// its new-chat action; universal has one reset path, so it lives with it.
export const $introSeed = atom<number>(0)

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

/** A payload's string list (clarify / approval `choices`), or null when absent. */
export function coerceStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  return value.filter((item): item is string => typeof item === 'string')
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

// Gateway/provider failures sometimes arrive as `message.complete` text instead
// of an `error` event. Treat matches as inline assistant errors (desktop
// use-message-stream/utils.ts `completionErrorText`).
const COMPLETION_ERROR_PATTERNS = [
  /^API call failed after \d+ retries:/i,
  /^HTTP\s+\d{3}\b/i,
  /^(Provider|Gateway)\s+error:/i
]

function completionErrorText(finalText: string): null | string {
  return finalText && COMPLETION_ERROR_PATTERNS.some(re => re.test(finalText)) ? finalText : null
}

const normalizeForCompare = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Concatenated text parts. Local (not lib/chat-messages) to keep this module
 *  importable from there without a runtime cycle. */
const messageText = (message: ChatMessage): string =>
  message.parts.map(part => (part.type === 'text' ? part.text : '')).join('')

/**
 * Settle a turn's parts against the authoritative `final_response` the gateway
 * ships on `message.complete` (tui_gateway/server.py).
 *
 * The reply does NOT always arrive as `message.delta`: providers that only
 * stream their reasoning channel deliver the answer whole at the end, so the
 * live transcript showed the response inside a "Thinking" disclosure and no
 * prose at all — correct only after a reload, which re-reads the stored
 * transcript. Desktop settles this in `completeAssistantMessage`; universal
 * never applied the final text.
 *
 * Divergence from desktop, both deliberate: desktop replaces *every* text part
 * with one final part appended at the end, which reorders tool-interleaved
 * prose and drops it entirely when the completion carries no text (an
 * interrupted turn's partial). Here the final text only lands where it can't
 * lose anything — no text part yet, or exactly one to overwrite in place.
 */
function finalizeParts(parts: ChatPart[], finalText: string): ChatPart[] {
  const reference = normalizeForCompare(finalText)

  // Drop a thinking block that IS the answer (the streamed-as-reasoning case).
  // Prefix either way: the reasoning channel may carry a capped prefix, or the
  // full text the gateway then repeats verbatim.
  const kept = parts.filter(part => {
    if (part.type !== 'reasoning') {
      return true
    }

    const text = normalizeForCompare(part.text)

    return !(text && (reference.startsWith(text) || text.startsWith(reference)))
  })

  const textIndexes = kept.reduce<number[]>((acc, part, index) => (part.type === 'text' ? [...acc, index] : acc), [])

  if (textIndexes.length === 0) {
    return [...kept, { type: 'text', text: finalText }]
  }

  // One text part = one streamed answer: overwrite in place so the final text
  // completes a truncated stream without moving it past the tool rows.
  if (textIndexes.length === 1) {
    const copy = kept.slice()
    copy[textIndexes[0]] = { type: 'text', text: finalText }

    return copy
  }

  // Tool-interleaved prose: the completion text maps to one of several parts and
  // we can't tell which, so leave the streamed transcript alone.
  return kept
}

function applyCompletion(messages: ChatMessage[], finalText: string): ChatMessage[] {
  const error = completionErrorText(finalText)

  const settle = (message: ChatMessage): ChatMessage =>
    error
      ? { ...message, error, parts: message.parts.filter(part => part.type !== 'text'), pending: false }
      : { ...message, parts: finalizeParts(message.parts, finalText), pending: false }

  // An empty completion carries no authority (an interrupted turn reports no
  // final response) — settle whatever streamed instead of erasing it.
  if (!finalText) {
    return messages.map(message => (message.pending ? { ...message, pending: false } : message))
  }

  let index = -1

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      index = i

      break
    }
  }

  const existing = index === -1 ? null : messages[index]

  // A settled assistant that already says exactly this is the same turn arriving
  // twice (a trailing completion); anything else is a new reply with no bubble.
  if (existing && (existing.pending || messageText(existing).trim() === finalText)) {
    return messages.map((message, i) => (i === index ? settle(message) : message))
  }

  return [...messages, settle(newAssistant())]
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
      // `text` is the turn's final_response; `rendered` is its ANSI/markdown
      // render (desktop reads the same pair).
      update(messages =>
        applyCompletion(messages, (coerceText(payload.text) || coerceText(payload.rendered)).trim())
      )

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
        // false only when a tirith warning forbids it; backend omits the field otherwise.
        allowPermanent: payload.allow_permanent !== false,
        choices: coerceStringList(payload.choices) ?? undefined,
        smartDenied: payload.smart_denied === true
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
    case 'clarify.request': {
      // The Python side is blocked on `clarify.respond` (tools/clarify_tool.py +
      // tui_gateway/server.py `_block`), so dropping this event hangs the agent
      // until its timeout. The gateway sends `question` + `choices` — NOT
      // `prompt`; the other keys are tolerated only as a fallback.
      const requestId = coerceText(payload.request_id)
      const question = coerceText(payload.question) || coerceText(payload.prompt) || coerceText(payload.message)

      if (requestId && question) {
        $clarify.set({ requestId, question, choices: coerceStringList(payload.choices) })
        setPetActivity({ awaitingInput: true }) // pet: waiting pose (blocked on user)
        void triggerHaptic('warning')
        dispatchNativeNotification({
          kind: 'input',
          title: translateNow('notifications.native.inputTitle'),
          body: question,
          sessionId: $sessionId.get()
        })
      }

      break
    }

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
  /no longer in session history|not in session history/i.test(
    error instanceof Error ? error.message : String(error)
  )

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

  $messages.set([...messages.slice(0, plan.sourceIndex), plan.editedMessage])
  $busy.set(true)
  $turnStartedAt.set(Date.now())
  $statusLine.set('')

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
    $messages.set(messages)
    $busy.set(false)
    $turnStartedAt.set(null)
    $statusLine.set(err instanceof Error ? err.message : String(err))
    notifyError(err, translateNow('desktop.editFailed'))
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

/** Answer the pending clarify. Unlike the other prompt responders this does NOT
 *  clear optimistically: the inline panel keeps the question on screen and
 *  surfaces the error if the send fails, so the user can retry instead of losing
 *  the (still-blocked) prompt. Throws on failure. */
export async function respondClarify(answer: string): Promise<void> {
  const req = $clarify.get()

  if (!req) {
    return
  }

  await requestGateway('clarify.respond', { request_id: req.requestId, answer })

  // Only drop the request once the gateway has it; `tool.complete` lands next
  // and swaps the inline panel to its settled Q&A view.
  if ($clarify.get()?.requestId === req.requestId) {
    $clarify.set(null)
    setPetActivity({ awaitingInput: false })
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
  $introSeed.set($introSeed.get() + 1)
  stopSpeaking()
}
