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

import { requestGateway } from '@/store/gateway'
import { clearSessionClarify, sessionClarifyRequest } from '@/store/prompts'

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

/** Is a clarify parked on this session right now? Imperative, for the composer. */
export const hasClarifyRequest = (key: null | string | undefined): boolean =>
  Boolean(key && sessionClarifyRequest(key).get())

/**
 * Answer the pending clarify with the empty string — the same thing the card's
 * own Skip button sends, and what the user typing a real message into the
 * composer means: "none of these".
 *
 * The request is cleared FIRST so a second Enter can't answer twice, and the
 * RPC failure is swallowed: the tool times out on its own, and a failed skip
 * must never swallow the message the user was actually sending. `true` when
 * there was something to skip.
 */
export async function skipClarifyRequest(key: null | string | undefined): Promise<boolean> {
  const request = key ? sessionClarifyRequest(key).get() : null

  if (!key || !request) {
    return false
  }

  clearSessionClarify(key)

  try {
    await requestGateway('clarify.respond', { request_id: request.requestId, answer: '' })
  } catch {
    /* the tool times out on its own; never block the real message on this */
  }

  return true
}
