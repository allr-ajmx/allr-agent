/**
 * Quick Entry — the state behind the global-chord mini composer (MJXHRM-384).
 *
 * Quick Entry is the HUD's opposite. The HUD is the whole conversation, moved
 * somewhere else; Quick Entry is a single line of text and nothing else — a
 * capture surface you summon from inside another application, type one sentence
 * into, and never see again.
 *
 * The window it lives in carries NO gateway connection of its own. It hands the
 * typed text to the PRIMARY window, which submits it through the same prompt
 * path the real composer uses (`app/quick-entry/bridge.ts`). There is no second
 * submit path and no new gateway RPC — a capture surface that dialled the
 * backend itself would be a second client for one user's one prompt.
 *
 * Ported from desktop `store/quick-entry.ts`. The reducer below is the verbatim
 * half: it is pure, it is unit-tested, and every behaviour in it is one a user
 * would actually notice. Desktop's other half — the `window.hermesDesktop`
 * settings bridge, which existed because Electron's MAIN process owned the OS
 * accelerator — has no counterpart here: universal registers global chords from
 * the rebindable keybind registry (`lib/keybinds/global-shortcut.ts`), so the
 * only device-local preference left is the on/off switch at the bottom of this
 * file.
 */

import { Codecs, persistentAtom } from '@/lib/persisted'
import type { SessionInfo } from '@/types/hermes'

/** Send into whatever chat the primary window currently has in front. */
export const QUICK_TARGET_CURRENT = 'current'
/** Start a brand-new session for this prompt. */
export const QUICK_TARGET_NEW = 'new'

/** A recent session the quick window can target (pushed by the primary). */
export interface QuickEntrySessionOption {
  id: string
  title: string
}

/**
 * The primary window's push into the quick window: is the gateway usable, and
 * which recent sessions can be targeted. The quick window has NO gateway of its
 * own, so this pushed copy is its only view of backend truth — it starts
 * disconnected (input disabled) until the first push proves otherwise.
 */
export interface QuickEntryStatePush {
  connected: boolean
  sessions: QuickEntrySessionOption[]
}

/** What a quick-window submit carries back to the primary window. */
export interface QuickEntrySubmitPayload {
  /** QUICK_TARGET_CURRENT, QUICK_TARGET_NEW, or a stored session id. */
  target: string
  text: string
}

/**
 * The quick window's own composer state. Deliberately a tiny pure reducer: the
 * behavior that would actually break a user — an empty submit must not send but
 * must still not hide the window, a real submit clears the draft AND hides, a
 * double-fire while already submitting must not send twice, and a dead gateway
 * must disable sending entirely — is the part worth proving, and none of it
 * needs React or a window system.
 */
export interface QuickComposerState {
  /** Last pushed gateway truth. False (the initial value) disables submit. */
  connected: boolean
  draft: string
  /** Recent sessions the picker offers, pushed by the primary window. */
  sessions: QuickEntrySessionOption[]
  /** True between a send and the window actually hiding. Blocks a double-send. */
  submitting: boolean
  /** Where a submit lands: current / new / a stored session id. */
  target: string
  /** Whether the window should be visible. False asks the shell to dismiss. */
  visible: boolean
}

export type QuickComposerEvent =
  | { type: 'blur' }
  | { type: 'dismiss' }
  | { type: 'edit'; draft: string }
  | { type: 'shown' }
  | { type: 'state'; connected: boolean; sessions: QuickEntrySessionOption[] }
  | { type: 'submit' }
  | { type: 'target'; target: string }

export interface QuickComposerTransition {
  /** Payload to hand the primary window, or null for none. */
  send: null | QuickEntrySubmitPayload
  state: QuickComposerState
}

export const initialQuickComposerState: QuickComposerState = {
  // Disconnected until the primary window's first push proves otherwise — a
  // capture window that accepts text it can never deliver is a lie.
  connected: false,
  draft: '',
  sessions: [],
  submitting: false,
  target: QUICK_TARGET_CURRENT,
  visible: true
}

export function quickComposerReducer(state: QuickComposerState, event: QuickComposerEvent): QuickComposerTransition {
  switch (event.type) {
    case 'blur':
    case 'dismiss': {
      // Escape / focus loss discards without sending. A dismiss mid-submit still
      // hides — the send already left for the primary window.
      return {
        send: null,
        state: { ...state, draft: '', submitting: false, target: QUICK_TARGET_CURRENT, visible: false }
      }
    }

    case 'edit': {
      return { send: null, state: { ...state, draft: event.draft } }
    }

    case 'shown': {
      // Re-summoned: a fresh capture surface every time — never a stale draft or
      // a leftover target — but the pushed gateway truth carries over.
      return {
        send: null,
        state: { ...state, draft: '', submitting: false, target: QUICK_TARGET_CURRENT, visible: true }
      }
    }

    case 'state': {
      // Adopt the pushed truth. A selected session that no longer exists in the
      // pushed list must not silently swallow the prompt — fall back to current.
      const targetStillValid =
        event.connected &&
        (state.target === QUICK_TARGET_CURRENT ||
          state.target === QUICK_TARGET_NEW ||
          event.sessions.some(session => session.id === state.target))

      return {
        send: null,
        state: {
          ...state,
          connected: event.connected,
          sessions: event.sessions,
          target: targetStillValid ? state.target : QUICK_TARGET_CURRENT
        }
      }
    }

    case 'submit': {
      const text = state.draft.trim()

      // Nothing to send — or nowhere to send it (gateway down): stay open and
      // keep the draft so a stray Enter can't make the text vanish.
      if (!text || state.submitting || !state.connected) {
        return { send: null, state }
      }

      return {
        send: { target: state.target, text },
        state: { ...state, draft: '', submitting: true, visible: false }
      }
    }

    case 'target': {
      return { send: null, state: { ...state, target: event.target } }
    }

    default: {
      return { send: null, state }
    }
  }
}

// ── The picker's options ────────────────────────────────────────────────────

/** The picker is a capture aid, not a session browser — a handful of recent
 *  rows is the whole point. */
export const QUICK_ENTRY_SESSION_OPTIONS = 5

/**
 * The recent sessions the picker offers, from the primary window's session list.
 *
 * Pure and taking the list as an argument rather than reading `$sessions`
 * itself, so the mapping that decides what a row is CALLED — and the archived
 * filter, which is the difference between offering a live conversation and
 * offering a dead one — is testable without a store.
 */
export function quickEntrySessionOptions(sessions: readonly SessionInfo[]): QuickEntrySessionOption[] {
  return sessions
    .filter(session => !session.archived)
    .slice(0, QUICK_ENTRY_SESSION_OPTIONS)
    .map(session => ({
      id: session.id,
      // The id is the last resort, not a nice label — but a row with no text at
      // all is a row the user cannot aim at.
      title: session.title?.trim() || session.preview?.trim() || session.id
    }))
}

/**
 * Validate a submit that arrived over the window event bus.
 *
 * Any window of this app can emit on the channel, so the primary window treats
 * the payload as data rather than as a promise. Desktop additionally tolerated a
 * bare string (a v1 quick window left behind by a partial update); universal has
 * never shipped that wire shape, so this only accepts the object.
 */
export function normalizeQuickEntrySubmit(raw: unknown): null | QuickEntrySubmitPayload {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const record = raw as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : ''

  if (!text.trim()) {
    return null
  }

  return {
    target: typeof record.target === 'string' && record.target ? record.target : QUICK_TARGET_CURRENT,
    text
  }
}

// ── Device-local preference ─────────────────────────────────────────────────

/**
 * Whether the chord summons Quick Entry at all.
 *
 * A device-local preference (`lib/persisted`, like keep-awake and the terminal
 * host override) rather than a file in userData: universal keeps this class of
 * "this computer only, nothing to send the gateway" knob in the webview, and
 * there is no main process here to be authoritative instead.
 *
 * Default ON, matching desktop — the feature is inert until its chord is
 * pressed, and on universal that chord ships unbound (see
 * `lib/keybinds/actions.ts`), so a default-on switch costs a user nothing.
 */
export const $quickEntryEnabled = persistentAtom<boolean>('hermes.quickEntry', true, Codecs.bool)

export function setQuickEntryEnabled(on: boolean): void {
  $quickEntryEnabled.set(on)
}
