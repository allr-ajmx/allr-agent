import type { Translations } from '@/i18n'

// The create form's rules, kept out of the component so they are testable and so
// there is ONE statement of each. Every rule here mirrors a 400 the backend
// (`create_webhook` in hermes_cli/web_server.py) would otherwise answer with —
// the point is that the user never has to learn them from an HTTP error.

/** The backend's own normalisation: `(name or "").strip().lower().replace(" ", "-")`. */
export function normalizeWebhookName(raw: string): string {
  return raw.trim().toLowerCase().replaceAll(' ', '-')
}

/** The backend's own validity test, verbatim. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export const DELIVER_LOG = 'log'

export interface WebhookCreateDraft {
  deliver: string
  deliverOnly: boolean
  name: string
}

/** Why this draft cannot be submitted, or null. */
export function webhookCreateError(draft: WebhookCreateDraft, w: Translations['webhooks']): null | string {
  const name = normalizeWebhookName(draft.name)

  if (!name) {
    return w.nameRequired
  }

  if (!NAME_PATTERN.test(name)) {
    return w.nameInvalid
  }

  // "Direct delivery requires a real target (telegram, discord, …), not 'log'."
  if (draft.deliverOnly && draft.deliver === DELIVER_LOG) {
    return w.deliverOnlyNeedsTarget
  }

  return null
}

/**
 * The user-facing half of a failed request.
 *
 * `ApiError.message` is `POST /api/webhooks → HTTP 400: {"detail":"…"}`; the
 * detail is the only part that tells the user what to change, and a create that
 * failed must say so rather than looking like one that worked.
 */
export function readableCreateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const detail = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)?.[1]

  return detail ? detail.replaceAll('\\"', '"') : message
}

/** `a, b , ,c` → `['a','b','c']`. */
export function splitWebhookList(raw: string): string[] {
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}
