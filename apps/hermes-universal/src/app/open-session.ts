/**
 * ONE door for "open this session".
 *
 * Every surface that can name a session — the sidebar, the command palette, a
 * notification, an agent-written `@session:` chip — has to make the same three
 * decisions: is it already on screen, does it take over the main chat, and does
 * a modifier mean "beside" instead of "instead of". Answering those in each
 * caller is how the same session ends up open twice.
 *
 * Ported from desktop `app/open-session.ts`. The window intent is deliberately
 * absent: universal's satellite windows are a different mechanism, and a chip
 * click has no need of one.
 */

import { openSession as loadSession } from '@/store/session'
import { focusOpenSession, openSessionTile, reuseBlankDraftTile } from '@/store/session-states'

/**
 * - `in-place` — a click / Enter. Front it if it is already on screen,
 *   otherwise load it into the main chat.
 * - `tab` — a modifier-click or a session ref. Front it if it is on screen,
 *   otherwise open it BESIDE what is there. Never takes over the main chat.
 */
export type OpenSessionIntent = 'in-place' | 'tab'

/** The intent a click's modifiers ask for. Cmd/Ctrl means "beside, not
 *  instead of" — the same convention as a link in a browser. */
export function openSessionIntentFromModifiers(
  event?: null | { ctrlKey?: boolean; metaKey?: boolean },
  base: OpenSessionIntent = 'in-place'
): OpenSessionIntent {
  return event?.metaKey || event?.ctrlKey ? 'tab' : base
}

/** Open a stored session. No-op on an empty id. */
export function openSessionRef(storedSessionId: string, intent: OpenSessionIntent = 'in-place'): void {
  const id = storedSessionId.trim()

  if (!id) {
    return
  }

  // Already on screen in either sense (a tile, or loaded in main): front it.
  // Opening it again would duplicate a conversation the user is looking at.
  if (focusOpenSession(id)) {
    return
  }

  if (intent === 'tab') {
    // Nothing to jump to, but an open tab may still be an empty "New session" —
    // that IS the tab the user would have typed into, so spend it rather than
    // stacking a second blank one beside it.
    if (reuseBlankDraftTile(id)) {
      return
    }

    openSessionTile(id, 'right')

    return
  }

  void loadSession(id)
}
