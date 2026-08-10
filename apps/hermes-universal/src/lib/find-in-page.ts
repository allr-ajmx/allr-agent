// Pure logic for the find-in-page bar (⌘F). Kept out of the component so the
// match-counter projection, the ordinal walk and the in-bar key routing can be
// unit-tested without jsdom or a Tauri runtime.
//
// The engine side lives in `src-tauri/src/find_in_page.rs`; this is strictly
// frontend presentation logic.
//
// Ported from desktop `lib/find-in-page.ts`, with one addition it doesn't need:
// `stepOrdinal`. Electron reports which match is selected; WebKitGTK reports
// only how many there are, so universal walks the ordinal itself.

/**
 * Counter shown next to the input, e.g. `"3/12"`.
 *
 * Three distinct states, and they are not the same thing:
 * - No query → `''`. The counter hides entirely rather than claiming "0/0"
 *   before the user has asked anything.
 * - A query with no matches → `'0/0'`. An explicit, honest zero.
 * - A query with matches → `'<ordinal>/<count>'`.
 *
 * The ordinal is clamped into `[0, count]` rather than trusted: it is a running
 * count of steps, and a document that changes under an open find bar can leave
 * it pointing past the end.
 */
export function formatMatchLabel(query: string, activeMatchOrdinal: number, matchCount: number): string {
  if (!query) {
    return ''
  }

  const count = Number.isFinite(matchCount) && matchCount > 0 ? Math.floor(matchCount) : 0

  if (count === 0) {
    return '0/0'
  }

  const raw = Number.isFinite(activeMatchOrdinal) ? Math.floor(activeMatchOrdinal) : 0
  const ordinal = Math.min(Math.max(raw, 0), count)

  return `${ordinal}/${count}`
}

/**
 * Where the selection lands after one step.
 *
 * WebKitGTK's find controller reports the match COUNT and nothing else — there
 * is no equivalent of Electron's `activeMatchOrdinal` — so "3 of 12" has to be
 * counted on this side. The search wraps (the Rust side passes `WRAP_AROUND`),
 * so stepping past either end comes back round, and the counter must agree with
 * what the page just did.
 *
 * 1-indexed, and 0 means "nothing selected": a query with no matches has no
 * position to be at.
 */
export function stepOrdinal(current: number, count: number, direction: 'forward' | 'backward'): number {
  if (!Number.isFinite(count) || count <= 0) {
    return 0
  }

  const total = Math.floor(count)
  const raw = Number.isFinite(current) ? Math.floor(current) : 0
  const ordinal = Math.min(Math.max(raw, 0), total)

  if (direction === 'forward') {
    return ordinal >= total ? 1 : ordinal + 1
  }

  return ordinal <= 1 ? total : ordinal - 1
}

/** What a keypress means to an open find bar. `null` = not ours, let it through. */
export type FindBarKeyAction = 'close' | 'next' | 'previous' | null

/** The subset of a keyboard event the matcher needs — works for DOM and React events. */
export interface FindBarKeyEvent {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/**
 * Map a keypress to a find-bar action while the bar is open.
 *
 * Two families, matching the platform convention Chrome/Safari/VS Code all
 * share:
 * - Bare `Enter` / `Shift+Enter` step forward / backward. Only valid while
 *   focus is in the find input, so callers pass `inInput: true` there.
 * - `⌘G` / `⌘⇧G` (Ctrl+G / Ctrl+Shift+G off macOS) step forward / backward
 *   from anywhere while the bar is open — that is the accelerator pair, and it
 *   must not require the input to hold focus.
 * - `Escape` closes from anywhere.
 *
 * `Alt` is treated as disqualifying so ⌥⌘G and friends fall through to
 * whatever else may want them instead of being silently swallowed.
 */
export function findBarKeyAction(event: FindBarKeyEvent, options: { inInput?: boolean } = {}): FindBarKeyAction {
  if (event.altKey) {
    return null
  }

  const mod = Boolean(event.metaKey || event.ctrlKey)

  if (event.key === 'Escape') {
    return mod ? null : 'close'
  }

  // `event.key` for the G key is 'g' unshifted and 'G' with Shift held, so
  // compare case-insensitively and read direction from `shiftKey` alone.
  if (mod && event.key.toLowerCase() === 'g') {
    return event.shiftKey ? 'previous' : 'next'
  }

  if (event.key === 'Enter' && !mod && options.inInput) {
    return event.shiftKey ? 'previous' : 'next'
  }

  return null
}

/**
 * Combos the OPEN find bar owns, in canonical `comboFromEvent` form.
 *
 * The global keybind dispatcher (`app/hooks/use-keybinds.ts`) consults this
 * before routing a combo to the registry. Without it, three real collisions
 * fire alongside the find bar:
 * - `mod+g` → `view.toggleReview` (⌘G is the review pane's shipped default).
 * - `mod+shift+g` → whatever a user has bound there.
 * - `escape` → the composer's cancel, which would abort a running turn while
 *   the user only meant to dismiss the find bar.
 *
 * `stopPropagation` cannot solve this: both listeners sit on `window` in the
 * capture phase, and propagation control does not suppress sibling listeners on
 * the same target. Ownership has to be decided by the dispatcher, which is the
 * single owner of combo dispatch.
 */
export function findBarClaimsCombo(combo: string): boolean {
  return combo === 'mod+g' || combo === 'mod+shift+g' || combo === 'escape'
}
