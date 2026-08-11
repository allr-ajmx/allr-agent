import { coerceFocusValue } from '@/lib/focus-view'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'

/**
 * Focus view state — the reduced-output mode `/focus` switches.
 *
 * Two halves, on purpose:
 *
 * - **Local** (`$focusView`): what this client renders. Persisted so a reload
 *   doesn't drop the user back into a wall of tool rows, and read by the
 *   transcript on every paint, so toggling is instant and never waits on a
 *   round trip.
 * - **Shared** (`display.focus_view` on the gateway): the same flag the CLI's
 *   `/focus` writes, so the mode travels across surfaces. Written with
 *   `display_only`, which tells the gateway to record the flag WITHOUT pinning
 *   `display.tool_progress` to "off" — that pin makes the gateway stop emitting
 *   tool events entirely (`_on_tool_start`), which for a GUI would take the
 *   todo panel, the changed-files card and generated images down with it, and
 *   would make hidden rows unrecoverable rather than one click away.
 *
 * Requesters are injected rather than imported so this module stays free of the
 * gateway singleton (same shape as `store/approval-mode.ts`).
 */

export type FocusRequester = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export const $focusView = persistentAtom('hermes.focusView', false, Codecs.bool)

/**
 * Tool runs the user has un-hidden while focus is still on, by run key. A plain
 * array (not a Set) so nanostores publishes a new identity on every change and
 * subscribed rows actually re-render.
 */
export const $focusRevealedRuns = atom<readonly string[]>([])

export function isFocusRunRevealed(revealed: readonly string[], key: string): boolean {
  return revealed.includes(key)
}

export function revealFocusRun(key: string): void {
  const current = $focusRevealedRuns.get()

  if (!key || current.includes(key)) {
    return
  }

  $focusRevealedRuns.set([...current, key])
}

/** Local-only switch. Leaving focus clears the reveals, so re-entering it later
 *  starts hidden again rather than resurrecting last hour's exceptions. */
export function setFocusViewLocal(enabled: boolean): void {
  if ($focusView.get() === enabled) {
    return
  }

  $focusView.set(enabled)

  if (!enabled) {
    $focusRevealedRuns.set([])
  }
}

/** Adopt the gateway's shared flag (called when a connection comes up). */
export async function syncFocusView(request: FocusRequester): Promise<boolean> {
  const result = (await request('config.get', { key: 'focus' })) as { value?: unknown }
  const enabled = coerceFocusValue(result?.value)
  setFocusViewLocal(enabled)

  return enabled
}

export interface FocusPushResult {
  /** False when the gateway ignored `display_only` and pinned tool progress off
   *  anyway (an older backend) — the caller says so rather than leaving the user
   *  to wonder why nothing can be revealed any more. */
  displayOnly: boolean
  enabled: boolean
}

/** Switch locally, then record the shared flag. The local half is applied first
 *  and deliberately NOT rolled back on a failed write: the user asked this
 *  client to reduce its output, and it can do that whatever the gateway says. */
export async function pushFocusView(request: FocusRequester, enabled: boolean): Promise<FocusPushResult> {
  setFocusViewLocal(enabled)

  const result = (await request('config.set', {
    key: 'focus',
    value: enabled ? 'on' : 'off',
    display_only: true
  })) as { display_only?: unknown; value?: unknown }

  const authoritative = coerceFocusValue(result?.value)
  setFocusViewLocal(authoritative)

  return { displayOnly: result?.display_only === true, enabled: authoritative }
}
