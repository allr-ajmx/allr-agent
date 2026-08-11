/**
 * The primary window's half of Quick Entry (MJXHRM-384).
 *
 * Both ways:
 *
 * - **Inbound** — text captured in the quick window is routed by target and
 *   submitted through THIS window's normal prompt machinery. The current chat
 *   rides `sendPrompt`, exactly as the real composer does; a picked stored
 *   session rides the session-tile delegate (resume + submit, in the background,
 *   without moving the primary view — the same path a tiled session uses); "new
 *   session" is `startNewSession()` followed by the same `sendPrompt`, which is
 *   precisely what clicking New chat and typing does. One submit pipeline, no
 *   bespoke RPC.
 * - **Outbound** — connection phase and the recent-session list are pushed to
 *   the quick window, so its input disables with a reconnect hint whenever the
 *   backend is unreachable rather than accepting text it cannot deliver.
 *
 * Installed lazily from `openQuickEntry()` rather than mounted in a component
 * tree, for the reason `installHudHandoff` is: the window that summons the quick
 * window is by definition the window that must submit for it, so the summoning
 * call site is where the responsibility lives — and an app that never summons it
 * pays nothing. Idempotent, because summoning happens over and over and stacked
 * listeners would send one prompt N times.
 *
 * Never in a satellite or a tile window: a second window also claiming the
 * capture channel is the same one-keystroke-N-prompts bug, and desktop guarded
 * the identical shape with `isAuxiliaryWindow`.
 */

import { IS_TAURI } from '@/lib/platform'
import { $connectionPhase } from '@/store/connection'
import {
  normalizeQuickEntrySubmit,
  QUICK_TARGET_CURRENT,
  QUICK_TARGET_NEW,
  quickEntrySessionOptions,
  type QuickEntryStatePush,
  type QuickEntrySubmitPayload
} from '@/store/quick-entry'
import { $sessions } from '@/store/session'
import { isSecondaryWindow } from '@/store/windows'

import { emitQuickEntryState, onQuickEntryHello, onQuickEntrySubmit } from './channel'

/**
 * What the quick window is told. `connected` is the gateway gate universal
 * actually has — `$connectionPhase === 'ready'` — where desktop asked its
 * `$gatewayState` whether the socket was open.
 */
export function quickEntryStatePush(): QuickEntryStatePush {
  return {
    connected: $connectionPhase.get() === 'ready',
    sessions: quickEntrySessionOptions($sessions.get())
  }
}

/**
 * Turn one captured payload into a real send.
 *
 * Every branch ends in a submit. A target that has gone stale — a session
 * deleted between the push and the Enter — must not swallow the prompt, so the
 * delegate path falls back to the current chat rather than failing silently.
 * That is the one behaviour here worth more than the code it costs.
 */
async function routeQuickEntrySubmit({ target, text }: QuickEntrySubmitPayload): Promise<void> {
  const { sendPrompt } = await import('@/store/chat')

  if (target === QUICK_TARGET_NEW) {
    const { startNewSession } = await import('@/store/new-session')

    // The same act as clicking New chat: a fresh draft in front, caret in it,
    // and then the normal submit is what creates the backend session.
    startNewSession()
    await sendPrompt(text)

    return
  }

  if (target !== QUICK_TARGET_CURRENT) {
    const { sessionTileDelegate } = await import('@/store/session-states')
    const delegate = sessionTileDelegate()

    if (delegate) {
      await delegate
        .resumeTile(target)
        .then(runtimeId => delegate.submitToSession(runtimeId, text))
        .catch(() => sendPrompt(text))

      return
    }
  }

  await sendPrompt(text)
}

let installed = false
let stopListening: (() => void) | null = null

export function installQuickEntryBridge(): void {
  if (installed || !IS_TAURI || isSecondaryWindow()) {
    return
  }

  installed = true

  const disposers: (() => void)[] = []

  void onQuickEntrySubmit(raw => {
    const payload = normalizeQuickEntrySubmit(raw)

    if (payload) {
      void routeQuickEntrySubmit(payload).catch(err => {
        console.warn('[quick-entry] submit failed', err)
      })
    }
  }).then(off => disposers.push(off))

  // The quick window opens long after the last state change, so it asks rather
  // than waiting for one. This is the cache Electron's main process used to hold.
  void onQuickEntryHello(() => void emitQuickEntryState(quickEntryStatePush())).then(off => disposers.push(off))

  const push = () => void emitQuickEntryState(quickEntryStatePush())

  disposers.push($connectionPhase.listen(push), $sessions.listen(push))

  stopListening = () => {
    for (const off of disposers.splice(0)) {
      off()
    }
  }
}

/** Test seam: drop the listeners and forget that the bridge was installed. */
export function resetQuickEntryBridge(): void {
  stopListening?.()
  stopListening = null
  installed = false
}
