/**
 * Soft focus / type-to-focus for the chat composer.
 *
 * On empty chat chrome, Enter focuses the composer; printable keys focus and
 * type. Bound shortcuts still win via the keybind index. Surfaces that own
 * keys (dialogs, menus, terminal, …) are left alone.
 */

import { $workspacePage } from '@/app/routes'
import { queryVisible } from '@/components/pane-shell/pane-visibility'
import { WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { $focusedChatPane } from '@/store/session-states'
import { switcherActive } from '@/store/session-switcher'

import { isEditableTarget, isFocusWithin } from './combo'

/** `composer.focus` defaults that need the surface/target gate. */
export const isComposerFocusSoftCombo = (combo: string) => combo === '/' || combo === 'enter'

const ENTER_ACTIVATES = [
  'a[href]',
  'button',
  'summary',
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="treeitem"]'
].join(',')

// Overlays that cover the whole window (portaled to the body, or the overlay
// shell itself) — one anywhere means the composer is behind it.
const BLOCKING_OVERLAY =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-overlay-surface]'

// Blockers that live INSIDE a chat surface. Inactive tabs stay mounted, so this
// one has to be visible-scoped: a clarify card waiting in a background thread
// must not take the foreground composer's letter keys.
const BLOCKING_IN_SURFACE = '[data-clarify-choices]'

/**
 * The ONE clarify card that owns its shortcut keys right now, or null.
 *
 * Keep-alive means every clarify card a zone ever showed is still MOUNTED, and a
 * split can put two of them on screen at once — but only one can own a keystroke
 * fired at the document. Resolving that here, once, is what lets the composer
 * (which stands down for the card) and the card itself (which acts) agree about
 * WHICH card it is. They used not to: the composer was already visible-scoped
 * while every mounted card bound the document unconditionally, so a clarify
 * parked in a background tab ate the foreground's letters and answered its own
 * question with them.
 */
export const keyOwningClarifyCard = (): HTMLElement | null => queryVisible(BLOCKING_IN_SURFACE)

/** True when the focused control would normally handle Enter itself. */
export function isActivateOnEnterTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null

  return Boolean(el && el !== document.body && el !== document.documentElement && el.closest(ENTER_ACTIVATES))
}

/**
 * True when a live clarify card binds THIS key, so type-to-focus must yield it.
 *
 * The card owns Enter plus the shortcuts it actually renders — `1..N+1` and
 * `A..` for its N choices and the trailing "Other" row. It does NOT own the
 * rest of the alphabet: typing a real message instead of picking an option is a
 * legitimate answer ("none of these"), and blanket-blocking every printable
 * left the user unable to start that message at all — the first letter vanished
 * and the composer never focused. Out-of-range keys fall through to the
 * composer, which skips the question on send.
 *
 * The choice count rides in the attribute's value, so this stays a DOM read
 * with no store coupling.
 */
export function clarifyCardOwnsKey(event: KeyboardEvent): boolean {
  const card = keyOwningClarifyCard()

  if (!card) {
    return false
  }

  if (event.key === 'Enter') {
    return true
  }

  // "Other" is the row past the last choice, hence the +1.
  const rows = Number(card.getAttribute('data-clarify-choices')) + 1

  if (!Number.isFinite(rows)) {
    return false
  }

  const key = event.key.toLowerCase()

  if (key.length !== 1) {
    return false
  }

  const index = /^[1-9]$/.test(key) ? Number(key) - 1 : key >= 'a' && key <= 'z' ? key.charCodeAt(0) - 97 : -1

  return index >= 0 && index < rows
}

/**
 * Dialogs, menus, terminal, the focused full page, session switcher, and any open overlay —
 * they keep their keys, so type-to-focus / soft `/` / Enter stand down rather
 * than stealing keystrokes those surfaces own (or leaking them into the composer
 * mounted behind an overlay). A live clarify card is handled per-key by
 * `clarifyCardOwnsKey`, not here — it only owns its own shortcuts.
 */
export function composerFocusBlockedBySurface(): boolean {
  return (
    switcherActive() ||
    // A page owns the keys only while it IS the focused chat surface. It lives in
    // the workspace pane, and a chat tile beside it must still take typing —
    // otherwise opening Capabilities silently kills the keyboard for every tile.
    ($workspacePage.get() !== null && $focusedChatPane.get() === WORKSPACE_PANE_ID) ||
    isFocusWithin('[data-terminal]') ||
    Boolean(document.querySelector(BLOCKING_OVERLAY))
  )
}

/** Printable `event.key` for type-to-focus, or null (modifiers / non-printables / IME). */
export function typeToFocusChar(event: KeyboardEvent): string | null {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
    return null
  }

  // Length 1 ⇒ letter/digit/punct/space; Enter/Tab/Arrows/Dead/F-keys are longer.
  return event.key.length === 1 ? event.key : null
}

/**
 * Whether soft focus / type-to-focus may run.
 * `combo` is `/` | `enter` | `'type'` (unbound printable); other chords pass.
 */
export function composerFocusKeysAllowed(event: KeyboardEvent, combo: string): boolean {
  if (combo !== 'type' && !isComposerFocusSoftCombo(combo)) {
    return true
  }

  if (
    event.defaultPrevented ||
    event.isComposing ||
    isEditableTarget(event.target) ||
    composerFocusBlockedBySurface() ||
    clarifyCardOwnsKey(event)
  ) {
    return false
  }

  return !(combo === 'enter' && isActivateOnEnterTarget(event.target))
}
