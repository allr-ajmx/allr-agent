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
 * Send into the current chat — or QUEUE it there when that chat is mid-turn.
 *
 * `sendPrompt` opens with `if (!trimmed || $busy.get()) return`. That guard is
 * right for the composer, which shows Stop instead of Send while a turn runs, so
 * the keystroke never gets that far. It is wrong for a capture surface: the
 * quick window has already cleared its draft and closed itself by the time this
 * runs, so a busy session meant the user's sentence vanished with nothing to
 * show for it — no send, no queue entry, no toast. And "fire a prompt at the
 * agent while it is working" is the single likeliest use of a global chord.
 *
 * The app already has the right answer to "Enter while busy": the composer's
 * QUEUE (mod+Enter), which parks the text per session and auto-drains it on the
 * settle edge (`store/composer-queue.ts`, `use-composer-queue.ts`). Queueing
 * under `$activeSessionKey` is queueing under exactly the key the primary
 * composer reads — its `activeQueueSessionKey` IS that atom (the primary session
 * view's `$runtimeId`) — so the entry shows up in the queue panel and sends
 * itself when the turn ends.
 *
 * Every import is resolved BEFORE the busy read, so the read and the send are
 * one synchronous step. An `await` in between would let a turn start after we
 * decided to send, and `sendPrompt` would drop the text on its own re-read.
 */
async function sendOrQueueCurrent(text: string): Promise<void> {
  const [{ $busy, sendPrompt }, { $activeSessionKey }, { enqueueQueuedPrompt }] = await Promise.all([
    import('@/store/chat'),
    import('@/store/session-state-types'),
    import('@/store/composer-queue')
  ])

  if ($busy.get()) {
    enqueueQueuedPrompt($activeSessionKey.get(), { attachments: [], text })

    return
  }

  await sendPrompt(text)
}

/**
 * Turn one captured payload into a real send.
 *
 * Every branch ends in a submit or a queue entry — nothing captured is ever
 * dropped. A target that has gone stale — a session deleted between the push and
 * the Enter — must not swallow the prompt either, so the delegate path falls
 * back to the current chat rather than failing silently. That is the one
 * behaviour here worth more than the code it costs.
 */
async function routeQuickEntrySubmit({ target, text }: QuickEntrySubmitPayload): Promise<void> {
  if (target === QUICK_TARGET_NEW) {
    const { startNewSession } = await import('@/store/new-session')

    // The same act as clicking New chat: a fresh draft in front, caret in it,
    // and then the normal submit is what creates the backend session. A fresh
    // draft is never busy, so this all but always takes the send path.
    startNewSession()
    await sendOrQueueCurrent(text)

    return
  }

  if (target !== QUICK_TARGET_CURRENT) {
    const { sessionTileDelegate } = await import('@/store/session-states')
    const delegate = sessionTileDelegate()

    if (delegate) {
      // `submitToSession` carries no busy guard of its own — a backgrounded
      // session is submitted to whatever it is doing — so only the fallback
      // needs the queue.
      await delegate
        .resumeTile(target)
        .then(runtimeId => delegate.submitToSession(runtimeId, text))
        .catch(() => sendOrQueueCurrent(text))

      return
    }
  }

  await sendOrQueueCurrent(text)
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
