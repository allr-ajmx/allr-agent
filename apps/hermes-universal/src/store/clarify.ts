/**
 * Clarify-choice hygiene.
 *
 * The pending request itself lives in `store/prompts.ts` alongside the other
 * blocking prompts (that is what makes it survive a session rekey — see
 * MJXHRM-207). What lives HERE is the part desktop keeps in its own
 * `store/clarify.ts`: making a choice list safe to render, and answering a
 * clarify without answering it.
 *
 * Choices come from a model's tool call, so they are only as well-formed as the
 * model made them. A blank entry renders an unlabelled button, a multi-line one
 * breaks the single-row layout, and a 4KB one pushes the panel off screen —
 * none of which the panel can recover from once rendered.
 */

import type { GatewayEvent } from '@/gateway'
import { coerceText } from '@/lib/chat-messages'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { clearSessionClarify, sessionClarifyRequest, setSessionClarify } from '@/store/prompts'
import { reduceSessionState } from '@/store/session-reducer'
import { updateSession } from '@/store/session-state-types'
import type { SessionResumeResponse } from '@/types/hermes'

/** Longest a choice may be and still read as a button label rather than prose. */
const MAX_CHOICE_LENGTH = 200

/**
 * The choices worth rendering. Anything blank, over-long, or multi-line is
 * dropped rather than rendered badly; an empty result means "free text only",
 * which the panel already handles.
 */
export function normalizeChoices(choices: unknown): string[] {
  if (!Array.isArray(choices)) {
    return []
  }

  return choices.filter(
    (choice): choice is string =>
      typeof choice === 'string' &&
      choice.trim().length > 0 &&
      choice.length <= MAX_CHOICE_LENGTH &&
      !choice.includes('\n')
  )
}

/**
 * Say so when a payload HAD choices and none survived.
 *
 * Silently degrading to a free-text box looks identical to a question the model
 * never offered options for, so a malformed tool call would be invisible.
 */
export function warnDroppedChoices(source: 'gateway' | 'tool_args', question: string, rawChoices: unknown): void {
  console.warn('[clarify] choices dropped after normalization', { source, question, rawChoices })
}

/** Normalize, warning when a non-empty payload normalized away to nothing. */
export function readChoices(source: 'gateway' | 'tool_args', question: string, rawChoices: unknown): string[] | null {
  const choices = normalizeChoices(rawChoices)

  if (rawChoices != null && choices.length === 0 && question) {
    warnDroppedChoices(source, question, rawChoices)
  }

  return choices.length > 0 ? choices : null
}

/**
 * The pending request this tool row is asking about — or null when the row and
 * the request are about different questions.
 *
 * A transcript can hold an OLD clarify row whose `tool.complete` never landed
 * (a disconnect ate it) while a NEW clarify is parked on the session. Both rows
 * would otherwise read the same store entry and offer to answer it. The question
 * is the only field the row and the request share, so it is the tie-break — and
 * a row with no question of its own (nothing but `tool.start`'s id ever reached
 * it) yields to the request rather than rendering blank.
 */
export function matchClarifyRequest<T extends { question: string }>(
  request: null | T | undefined,
  rowQuestion: string
): null | T {
  if (!request) {
    return null
  }

  return rowQuestion && request.question && rowQuestion !== request.question ? null : request
}

/**
 * Put back the clarify a resumed session is still parked on.
 *
 * `clarify.request` is emitted ONCE, with no replay buffer, and a parked turn is
 * not in the committed transcript — so a client that cold-opens (or reloads
 * into) a waiting session has neither the question nor the `request_id`, and the
 * agent stays in the backend's `_block` until its timeout. The gateway now
 * describes the parked prompt on `session.resume`
 * (`_session_pending_prompt`); replaying it through THE SAME reducer case the
 * live event uses is what rebuilds both halves — the store entry the panel
 * answers from, and the synthetic tool row it mounts on.
 *
 * Idempotent by construction: the store entry is a replace, and the reducer
 * upserts its row (correlating on `question`), so a session that still holds a
 * live clarify from before the reconnect keeps ONE card.
 */
export function applyResumedClarify(key: string, resumed: Pick<SessionResumeResponse, 'pending_prompt'>): void {
  const pending = resumed.pending_prompt

  if (!pending || pending.event !== 'clarify.request') {
    return
  }

  const payload = pending.payload ?? {}
  const requestId = coerceText(payload.request_id)
  const question = coerceText(payload.question)

  if (!requestId || !question) {
    return
  }

  setSessionClarify(key, { requestId, question, choices: readChoices('gateway', question, payload.choices) })
  updateSession(key, state =>
    reduceSessionState(state, { type: 'clarify.request' } as GatewayEvent, payload as Record<string, unknown>)
  )
}

/** Is a clarify parked on this session right now? Imperative, for the composer. */
export const hasClarifyRequest = (key: null | string | undefined): boolean =>
  Boolean(key && sessionClarifyRequest(key).get())

/**
 * Answer the pending clarify with the empty string — the same thing the card's
 * own Skip button sends, and what the user typing a real message into the
 * composer means: "none of these".
 *
 * The request is cleared FIRST so a second Enter can't answer twice, and the
 * failure never rejects: this is fire-and-forget beside the real send, and a
 * failed skip must not swallow the message the user was actually sending.
 * `true` when there was something to skip.
 *
 * But it must not be SILENT either (MJXHRM-418). "The tool times out on its
 * own" is not a guarantee: `_clarify_timeout_seconds()` returns None for a
 * configured timeout <= 0, and `_block(timeout=None)` then waits forever,
 * released only by a real answer or `session.interrupt`. With the card already
 * torn down there is nothing left that could ever answer it — the same dead end
 * the optimistic responders had, minus the five-minute floor. So a skip that
 * did not land puts the question BACK and says so, and the next Enter retries it.
 */
export async function skipClarifyRequest(key: null | string | undefined): Promise<boolean> {
  const request = key ? sessionClarifyRequest(key).get() : null

  if (!key || !request) {
    return false
  }

  clearSessionClarify(key)

  try {
    await requestGateway('clarify.respond', { request_id: request.requestId, answer: '' })
  } catch (error) {
    // Only if nothing newer has taken the slot in the meantime — restoring over
    // a fresh question would make THAT one unanswerable.
    if (!sessionClarifyRequest(key).get()) {
      setSessionClarify(key, request)
    }

    notifyError(error, 'The question could not be skipped — answer it to unblock the agent')
  }

  return true
}
