/**
 * TILE session reducer — a PARALLEL consumer of the single gateway event stream
 * (wired alongside `handleGatewayEvent` in `store/gateway.ts`). The primary
 * chat's reducer (`store/chat.ts#handleGatewayEvent`) is left untouched; this
 * handles events for OPEN TILE sessions only, reducing each into its
 * `$sessionStates` slice and routing its blocking prompts into the per-session
 * prompt atoms. Universal's answer to desktop's `use-session-state-cache` +
 * `use-message-stream` (which universal never had).
 *
 * Reuses the primary reducer's PURE transcript helpers (exported from
 * `store/chat.ts`) so a tile's bubbles read identically to the main thread.
 */

import type { GatewayEvent } from '@/gateway'
import { coerceThinkingText } from '@/lib/chat-runtime'
import { type GatewayToolPayload, upsertToolPart } from '@/lib/chat-tool-parts'
import { translateNow } from '@/i18n'
import {
  appendStreamPart,
  applySettledReasoning,
  coerceStringList,
  coerceText,
  patchActive,
  withActiveAssistant,
  $sessionId,
  type ChatMessage
} from '@/store/chat'
import { dispatchNativeNotification } from '@/store/native-notifications'
import {
  clearAllPrompts,
  setSessionApproval,
  setSessionClarify,
  setSessionSecret,
  setSessionSudo
} from '@/store/prompts'
import { type ClientSessionState } from '@/store/session-state-types'
import { $sessionStates, updateSession } from '@/store/session-states'

const patchLastAssistant = (
  state: ClientSessionState,
  patch: (m: ChatMessage) => ChatMessage
): ClientSessionState => ({ ...state, messages: patchActive(state.messages, patch) })

/** Reduce ONE gateway event into a tile session's state slice. Pure (returns a
 *  new state) — the transcript logic mirrors `store/chat.ts`'s primary reducer,
 *  minus its primary-only UI side-effects (pet / TTS / status line). */
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
        interrupted: false,
        messages: withActiveAssistant(state.messages)
      }

    case 'message.delta':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: appendStreamPart(m.parts, 'text', coerceText(payload.text))
      }))

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

      return patchLastAssistant(state, m => ({
        ...m,
        parts: [...m.parts, { type: 'reasoning', text: header + coerceThinkingText(payload.text) }]
      }))
    }

    case 'tool.start':
    case 'tool.progress':
    case 'tool.generating':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: upsertToolPart(m.parts, payload as GatewayToolPayload, 'running')
      }))

    case 'tool.complete':
      return patchLastAssistant(state, m => ({
        ...m,
        parts: upsertToolPart(m.parts, payload as GatewayToolPayload, 'complete')
      }))

    case 'message.complete':
      return {
        ...state,
        busy: false,
        turnStartedAt: null,
        needsInput: false,
        messages: state.messages.map(m => (m.pending ? { ...m, pending: false } : m))
      }

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
        messages: state.messages.map(m =>
          m.pending ? { ...m, pending: false, error: coerceText(payload.message) } : m
        )
      }

    default:
      return state
  }
}

/** The parallel stream consumer. Handles events for a KNOWN tile (non-primary)
 *  session only; everything else is left to `handleGatewayEvent`. */
export function routeTileEvent(event: GatewayEvent): void {
  const sid = (event.session_id || '').trim()

  if (!sid || sid === $sessionId.get() || !(sid in $sessionStates.get())) {
    return
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>

  // Per-session blocking prompts land in the keyed prompt atoms so the tile's
  // PromptOverlays can render them (the primary uses the global atoms + bars).
  switch (event.type) {
    case 'approval.request':
      setSessionApproval(sid, {
        command: coerceText(payload.command),
        description: coerceText(payload.description) || 'dangerous command',
        allowPermanent: payload.allow_permanent !== false
      })
      break

    case 'clarify.request':
      // The gateway sends `question` + `choices` (NOT `prompt`); the other keys
      // are tolerated only as a fallback. Mirrors chat.ts's primary reducer.
      setSessionClarify(sid, {
        requestId: coerceText(payload.request_id),
        question: coerceText(payload.question) || coerceText(payload.prompt) || coerceText(payload.message),
        choices: coerceStringList(payload.choices)
      })
      break

    case 'sudo.request':
      setSessionSudo(sid, {
        requestId: coerceText(payload.request_id),
        prompt: coerceText(payload.prompt) || coerceText(payload.command) || 'Enter your sudo password'
      })
      break

    case 'secret.request':
      setSessionSecret(sid, {
        requestId: coerceText(payload.request_id),
        envVar: coerceText(payload.env_var),
        prompt: coerceText(payload.prompt) || coerceText(payload.message)
      })
      break

    case 'message.complete':
      clearAllPrompts(sid)
      dispatchNativeNotification({
        kind: 'turnDone',
        title: translateNow('notifications.native.turnDoneTitle'),
        body: translateNow('notifications.native.turnDoneBody'),
        sessionId: sid
      })
      break

    case 'error':
      clearAllPrompts(sid)
      dispatchNativeNotification({
        kind: 'turnError',
        title: translateNow('notifications.native.turnErrorTitle'),
        body: coerceText(payload.message),
        sessionId: sid
      })
      break

    default:
      break
  }

  updateSession(sid, state => reduceSessionState(state, event, payload))
}
