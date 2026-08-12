/**
 * Transport re-home for POP-OUT windows (MJXHRM-371).
 *
 * # The same defect the HUD had, on the window kind nobody checked
 *
 * `app/hud/handoff.ts` explains the mechanism at length: every WebView the app
 * opens builds its own gateway socket, and the backend routes a session's events
 * to whichever connection last resumed it. So a second window showing a chat
 * takes that chat's stream, and the window it came from goes deaf.
 *
 * The HUD is not the only window that does this. `?win=tile` windows —
 * `detachTile()` (a tile moved into its own window) and `openSessionInNewWindow()`
 * (the sidebar's "Open in new window", the subagent pop-out, the delegate tool) —
 * render `TileWindowRoot`, which resumes the session in its route exactly as the
 * HUD does. Closing one used to put the tile back in its slot (`tile/detach.ts`)
 * and stop there: the tab reappears, the transcript is all there, and not one
 * further token ever arrives, because the slice is warm and warm slices are never
 * re-resumed (that short-circuit is the MJX-132 lossless switch).
 *
 * # Why this is not `openSession(id, { forceResume: true })`
 *
 * That is the HUD's answer, and it is right for the HUD: leaving HUD mode means
 * coming back to that conversation, so making it active is the point. A pop-out
 * is the opposite — the user closed a window they had put a chat in, while
 * working on something else in this one. Dragging the main pane onto that chat
 * would be a worse bug than the one being fixed. `reclaimSessionTransport()` is
 * the transport-only half: it rebinds the stream and moves nothing.
 *
 * # Ownership
 *
 * The window that OPENED the pop-out reclaims it, and no other. Two full app
 * windows can be up at once (⌘⇧N / "New window"), both listening on the same
 * app-wide native event; without an owner both would resume the same session and
 * the loser would be left deaf — the exact failure being repaired. So this holds
 * the labels it opened itself, the same bookkeeping `openedSatellites` does for
 * satellites, and ignores every other window's.
 */

import { notifyError } from '@/store/notifications'
import { TILE_WINDOW_CLOSED_EVENT } from '@/store/windows'

/**
 * Window label -> the stored session that window took the binding for.
 *
 * In memory rather than `localStorage` (the HUD's route): a pop-out cannot
 * outlive the process that opened it, and the map IS the ownership record — a
 * shared stash would be readable by the peer window that must not act on it.
 */
const popoutSessions = new Map<string, string>()

let installed = false

/** Reclaim without letting a failure vanish: a stream that never came back looks
 *  exactly like a quiet session until the next reply does not arrive. */
async function reclaim(storedSessionId: string): Promise<void> {
  try {
    // Lazily, for the reason `app/hud/handoff.ts` documents: the window layer
    // must not gain a static edge to the session store to hold a reference used
    // only when a pop-out closes.
    const { reclaimSessionTransport } = await import('@/store/session')

    await reclaimSessionTransport(storedSessionId)
  } catch (err) {
    notifyError(err, 'Could not take the conversation back from that window')
  }
}

/**
 * Listen for the native close. Armed on the first pop-out this window opens, so
 * an app that never opens one pays nothing, and idempotent because opening
 * happens over and over and stacked listeners would resume once per pop-out ever
 * opened.
 */
async function installPopoutTransportHandoff(): Promise<void> {
  if (installed) {
    return
  }

  installed = true

  try {
    const { listen } = await import('@tauri-apps/api/event')

    await listen<string>(TILE_WINDOW_CLOSED_EVENT, event => {
      const label = event.payload ?? ''
      const storedSessionId = popoutSessions.get(label)

      if (!storedSessionId) {
        return
      }

      // Consumed synchronously on the event, not inside the async reclaim: a
      // second close must not be able to interleave with an await and re-home
      // the same window twice.
      popoutSessions.delete(label)
      void reclaim(storedSessionId)
    })
  } catch {
    // No Tauri event bus (web, mobile) — and no pop-out windows there either, so
    // there is nothing to hear about. Left armed rather than retried: a platform
    // that has no bus now will not grow one.
  }
}

/**
 * Record that `label` is hosting `storedSessionId` and is therefore holding its
 * gateway stream. `null` forgets the window (it never got a chat to hold).
 *
 * Called by `store/windows.ts` with the label Rust hands back, which is the only
 * side that knows how a tile id is slugged into a label.
 */
export function notePopoutWindow(label: string, storedSessionId: null | string): void {
  if (!label) {
    return
  }

  if (!storedSessionId) {
    popoutSessions.delete(label)

    return
  }

  popoutSessions.set(label, storedSessionId)
  void installPopoutTransportHandoff()
}

/** Test seam: forget the installed listener and every recorded pop-out. */
export function resetPopoutTransport(): void {
  installed = false
  popoutSessions.clear()
}
