/**
 * Submit a prompt to the session a SURFACE owns.
 *
 * The primary chat sends through `sendPrompt`, which owns the things only the
 * main pane has: turning a draft into a real session, registering the new
 * sidebar row, and the pet. A tile is a view of a session that already exists,
 * so it goes through the tile delegate. Both paths append the user turn, go
 * busy, and open the in-flight turn on the session that actually received the
 * text.
 *
 * One helper because there are two callers — the composer's plain-text submit
 * and the slash dispatcher's `send`/`skill` directive — and while they were
 * written separately the second reached for `sendPrompt` unconditionally
 * (MJXHRM-419). `sendPrompt` is hard-bound to `$activeSessionKey` and opens with
 * `if (!trimmed || $busy.get()) return`, where `$busy` is the FOREGROUND chat's,
 * so a `/goal …` or a skill directive typed into a tile either opened its turn
 * on the main pane (leaving the tile idle and silent, and putting a turn on a
 * conversation the user was not typing into) or — whenever the main pane
 * happened to be mid-turn — returned having done nothing at all, with no error
 * and no busy state anywhere.
 */

import { sendPrompt } from '@/store/chat'
import { notify } from '@/store/notifications'
import { sessionTileDelegate } from '@/store/session-states'

import type { SessionView } from './session-view'

export async function submitPromptToSurface(view: SessionView, text: string): Promise<void> {
  if (view.kind === 'primary') {
    await sendPrompt(text)

    return
  }

  // The slice KEY, which is what the delegate addresses (see session-view:
  // `$runtimeId` is the key, not the wire id). Null on a tile whose session
  // never bound — a hydrate that failed and dropped its placeholder, or a
  // delegate that has not registered yet.
  const key = view.$runtimeId.get()
  const delegate = sessionTileDelegate()

  if (!key || !delegate) {
    // Callers clear the composer BEFORE calling this, so returning quietly is
    // exactly how a message disappears with nothing said about it.
    notify({
      kind: 'error',
      title: 'Session unavailable',
      message: 'This tile has no live session yet — reopen it and try again.'
    })

    return
  }

  await delegate.submitToSession(key, text)
}
