/**
 * Focus view — the reduced-output display mode behind `/focus`.
 *
 * Ported from `hermes_cli/focus_view.py`, argument grammar and wording included,
 * so the same command reads the same on every surface. What is deliberately NOT
 * ported is the mechanism: the CLI hides tool lines by never printing them
 * (`tool_progress_mode = "off"`), because a scrollback terminal cannot un-print
 * one. This client renders a transcript it owns, so it keeps receiving every
 * tool event and hides the ROWS — which is what makes "⋯ 3 tool lines hidden"
 * one click from shown, and what keeps the todo panel, the changed-files card
 * and generated images working while focus is on.
 *
 * Everything here is display-only. No part of this file touches conversation
 * history, the system prompt, or any request payload — the model sees an
 * identical turn either way.
 */

/** Config key the gateway persists the shared flag under (`config.get`/`set` key `focus`). */
export const FOCUS_CONFIG_KEY = 'display.focus_view'

const ON_WORDS = new Set(['on', 'enable', 'enabled', 'true', 'yes', '1'])
const OFF_WORDS = new Set(['off', 'disable', 'disabled', 'false', 'no', '0'])
const STATUS_WORDS = new Set(['status', 'show', '?'])
const TOGGLE_WORDS = new Set(['', 'toggle'])

export const FOCUS_USAGE = 'usage: /focus [on|off|status]'

export type FocusAction = 'set' | 'status' | 'usage'

export interface FocusArgResolution {
  action: FocusAction
  /** Requested state for `set`; null otherwise. */
  target: boolean | null
}

/**
 * Map a `/focus` argument onto an action. Bare `/focus` toggles, matching the
 * CLI's sibling display switches (`/footer`, `/battery`, `/timestamps`).
 */
export function resolveFocusArg(arg: string, current: boolean): FocusArgResolution {
  const text = String(arg ?? '')
    .trim()
    .toLowerCase()

  if (STATUS_WORDS.has(text)) {
    return { action: 'status', target: null }
  }

  if (ON_WORDS.has(text)) {
    return { action: 'set', target: true }
  }

  if (OFF_WORDS.has(text)) {
    return { action: 'set', target: false }
  }

  if (TOGGLE_WORDS.has(text)) {
    return { action: 'set', target: !current }
  }

  return { action: 'usage', target: null }
}

/** Confirmation line for a `/focus on|off` that changed something. */
export function formatFocusToggleMessage(enabled: boolean): string {
  return enabled
    ? 'Focus view enabled — just your prompt and the final response'
    : 'Focus view disabled — tool activity is shown again'
}

/** `/focus status` body. */
export function formatFocusStatus(enabled: boolean): string {
  return enabled
    ? 'Focus view: ON — only your prompt and the final response.\n  /focus off, or the ◉ focus badge in the status bar, shows tool activity again.'
    : 'Focus view: OFF — tool activity is shown.'
}

/**
 * The dim recovery line for a run of hidden tool rows, or null when nothing was
 * hidden. Counting is honest by construction here: the number is the rows this
 * client is actually holding back, not an estimate of what a different surface
 * would have printed.
 */
export function formatHiddenLine(count: number): null | string {
  const n = Number.isFinite(count) ? Math.trunc(count) : 0

  if (n <= 0) {
    return null
  }

  return `⋯ ${n} tool ${n === 1 ? 'line' : 'lines'} hidden`
}

/** Normalize whatever `config.get focus` answered into a boolean. */
export function coerceFocusValue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  return ON_WORDS.has(
    String(value ?? '')
      .trim()
      .toLowerCase()
  )
}
