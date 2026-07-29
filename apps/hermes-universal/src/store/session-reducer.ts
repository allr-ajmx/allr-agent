/**
 * THE transcript reducer — one pure function that folds a gateway event into ONE
 * session's slice. It is applied identically to every session: the chat on
 * screen, a layout-tree tile, a background mobile bubble.
 *
 * There used to be two reducers — this one for tiles and a parallel copy inside
 * `store/chat.ts` writing global atoms for the visible chat. Keeping them in
 * sync was the source of MJX-132 (a background session's tokens reaching the
 * on-screen transcript) and of quieter divergences: tiles never applied the
 * authoritative `final_response`, never rendered MEDIA: tags, and asked the
 * GLOBAL `$busy` whether a late tool event belonged to a settled turn.
 *
 * Side effects (pet, TTS, notifications, sound, workspace nudges) are NOT here —
 * they live in `store/event-router.ts`, which decides which of them are scoped
 * to the session that produced the event and which follow the active one.
 */

import type { GatewayEvent } from '@/gateway'
import {
  appendAssistantTextPart,
  appendStreamPart,
  applyCompletion,
  applySettledReasoning,
  type ChatMessage,
  coerceText,
  patchActive,
  withActiveAssistant
} from '@/lib/chat-messages'
import { coerceThinkingText } from '@/lib/chat-runtime'
import { type GatewayToolPayload, upsertToolPart } from '@/lib/chat-tool-parts'
import { type ClientSessionState } from '@/store/session-state-types'

const patchLastAssistant = (state: ClientSessionState, patch: (m: ChatMessage) => ChatMessage): ClientSessionState => ({
  ...state,
  messages: patchActive(state.messages, patch)
})

/**
 * Route a tool event into a session's transcript. While a turn is live the parts
 * land on the pending assistant; a LATE event (one arriving after
 * `message.complete` — a trailing completion, a sub-agent mirror) must merge
 * into the last assistant instead of opening a fresh `pending: true` bubble that
 * nothing ever settles.
 *
 * Desktop gets this from `pending: m => phase !== 'complete' || (m.pending ??
 * false)` in use-message-stream. The "is the turn settled?" question is answered
 * from THIS session's `busy`, never a global one — asking the global `$busy` (as
 * the old primary reducer did) makes one session's turn state decide where
 * another session's tool rows land.
 */
function applyToolEvent(
  state: ClientSessionState,
  payload: GatewayToolPayload,
  phase: 'complete' | 'running'
): ClientSessionState {
  const messages = state.messages
  const last = messages[messages.length - 1]
  const settledAssistant = !state.busy && last?.role === 'assistant' && !last.pending

  if (settledAssistant) {
    const copy = messages.slice()
    copy[copy.length - 1] = { ...last, parts: upsertToolPart(last.parts, payload, phase) }

    return { ...state, messages: copy }
  }

  return patchLastAssistant(state, m => ({ ...m, parts: upsertToolPart(m.parts, payload, phase) }))
}

/** Reduce ONE gateway event into ONE session's state slice. Pure. */
export function reduceSessionState(
  state: ClientSessionState,
  event: GatewayEvent,
  payload: Record<string, unknown>
): ClientSessionState {
  switch (event.type) {
    case 'message.start':
      return {
        ...state,
        busy: true,
        turnStartedAt: Date.now(),
        statusLine: '',
        interrupted: false,
        interimBoundaryPending: false,
        messages: withActiveAssistant(state.messages)
      }

    case 'message.delta':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: appendAssistantTextPart(m.parts, coerceText(payload.text))
      }))

    // An interim finalizes the current bubble mid-turn: the next delta opens a
    // fresh one rather than appending to a paragraph the agent considers done.
    case 'message.interim':
      return {
        ...state,
        interimBoundaryPending: true,
        messages: state.messages.map(m => (m.pending ? { ...m, pending: false } : m))
      }

    case 'reasoning.delta':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: appendStreamPart(m.parts, 'reasoning', coerceThinkingText(payload.text))
      }))

    case 'reasoning.available':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: applySettledReasoning(m.parts, coerceThinkingText(payload.text))
      }))
    case 'moa.reference': {
      const label = coerceText(payload.label)
      const idx = coerceText(payload.index)
      const total = coerceText(payload.total)
      const header = `◇ Reference ${idx}/${total}${label ? ` — ${label}` : ''}\n`

      // A reference block is its own labelled thinking block — never merged into
      // the neighbouring one (desktop appends it as a settled burst too).
      return patchLastAssistant(state, m => ({
        ...m,
        parts: [...m.parts, { type: 'reasoning', text: header + coerceThinkingText(payload.text) }]
      }))
    }

    case 'tool.start':

    case 'tool.progress':

    case 'tool.generating':
      return applyToolEvent(state, payload as GatewayToolPayload, 'running')

    case 'tool.complete':
      return applyToolEvent(state, payload as GatewayToolPayload, 'complete')

    case 'message.complete':
      return {
        ...state,
        busy: false,
        turnStartedAt: null,
        statusLine: '',
        needsInput: false,
        // `text` is the turn's final_response; `rendered` is its ANSI/markdown
        // render (desktop reads the same pair).
        messages: applyCompletion(state.messages, (coerceText(payload.text) || coerceText(payload.rendered)).trim())
      }

    case 'status.update':
      return { ...state, statusLine: coerceText(payload.status) || coerceText(payload.message) || '' }

    case 'session.info':
      // Truthiness-gated (desktop parity): an empty cwd means "unknown", not
      // "detach the current one".
      return typeof payload.cwd === 'string' && payload.cwd ? { ...state, cwd: payload.cwd } : state

    case 'approval.request':

    case 'clarify.request':

    case 'sudo.request':

    case 'secret.request':
      return { ...state, needsInput: true }

    case 'error':
      return {
        ...state,
        busy: false,
        turnStartedAt: null,
        needsInput: false,
        statusLine: coerceText(payload.message) || 'Something went wrong',
        messages: state.messages.map(m =>
          m.pending ? { ...m, pending: false, error: coerceText(payload.message) } : m
        )
      }

    default:
      return state
  }
}
