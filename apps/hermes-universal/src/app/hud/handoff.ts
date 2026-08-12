/**
 * HUD ⇄ main-window transport handoff (MJXHRM-371).
 *
 * # Why anything has to happen at all
 *
 * Every WebView the app opens builds its own `JsonRpcGatewayClient` over its own
 * Rust-backed socket — `transport/tauri-websocket.ts` mints a fresh id per
 * instance, so `ws_open` is a genuinely separate connection to the gateway. The
 * backend binds a session's event stream to ONE of those connections: whichever
 * last resumed or submitted it.
 *
 * So summoning the HUD onto a conversation moves that binding to the HUD, and
 * the main window stops hearing the session entirely — no deltas, no
 * turn-complete, no draft clear. There is nothing to poll for either: mid-turn,
 * nothing is persisted yet to re-pull.
 *
 * Leaving HUD mode is therefore a RE-HOME, not a window close.
 *
 * # Why the obvious version does not work
 *
 * `openSession()` short-circuits on a warm slice: it moves the active pointer
 * and issues no `session.resume`. That is deliberate and correct — it is what
 * makes switching mid-turn lossless (MJX-132) — but it means the natural
 * translation of desktop's handoff is a silent no-op here. After the HUD closes,
 * the main window's slice for that session IS warm, so a plain re-open would
 * rebind nothing and the window would stay deaf while looking fine.
 *
 * Hence `forceResume`: an opt-in, transport-only rebind that the seam in
 * `store/session.ts` provides for exactly this caller. The warm short-circuit
 * stays the default everywhere else.
 *
 * # Why the close signal comes from Rust
 *
 * The HUD is gone by the time the re-home has to run, and a torn-down WebKitGTK
 * view is the least reliable place to send a message from. `RunEvent::
 * WindowEvent::Destroyed` fires from tao whether or not the page ran anything,
 * so the native side announces the close and this module listens
 * (`SATELLITE_WINDOW_CLOSED_EVENT`).
 *
 * The session the HUD ended on travels the other way — through `localStorage`,
 * written while the HUD was still alive. That is not a fallback for the event
 * but the right shape for this half: the main window reads it AFTER the HUD is
 * destroyed, so a value already on disk cannot lose a race that a message sent
 * during teardown very much can.
 */

import { listen } from '@tauri-apps/api/event'

import { sessionRoute } from '@/app/routes'
import { IS_TAURI } from '@/lib/platform'
import { navigateTo } from '@/lib/route-nav'
import { reloadPersistedDrafts, requestComposerDraftSync } from '@/store/composer'
import { notifyError } from '@/store/notifications'
import {
  HUD_SURFACE,
  isSatelliteWindow,
  SATELLITE_WINDOW_CLOSED_EVENT,
  satelliteSurfaceFromLabel
} from '@/store/windows'

// `HUD_SURFACE` straight from the window store rather than through `hud.ts`'s
// re-export of the same value: `hud.ts` imports this module, so reaching back
// into it would close an import cycle for no gain.
//
// `@/store/session` is imported LAZILY, inside the re-home. `hud.ts` pulls this
// module in so it can arm the listener on summon, and summoning is reached from
// the titlebar and a hotkey — a static edge here would drag the whole session
// store into that path to hold a reference used only when a HUD closes.

/**
 * Where the HUD records the conversation it is on, for the window that will have
 * to take it back.
 *
 * `localStorage`, not `sessionStorage`: every window here is its own WebView
 * with its own session store, so a session-scoped write would never be visible
 * to the main window. Windows of one origin DO share `localStorage` — the same
 * property the composer's cross-window draft stash relies on.
 */
const HUD_SESSION_KEY = 'hermes:hud-session'

/** HUD side: record the conversation this window is on. Cleared with `null`. */
export function reportHudSession(storedSessionId: null | string): void {
  try {
    if (storedSessionId) {
      window.localStorage.setItem(HUD_SESSION_KEY, storedSessionId)
    } else {
      window.localStorage.removeItem(HUD_SESSION_KEY)
    }
  } catch {
    // Private mode / no storage. The re-home falls back to the session the main
    // window already had selected, which is the pre-HUD answer and never wrong,
    // only sometimes stale.
  }
}

/** The conversation the HUD ended on, consumed once. */
function takeReportedHudSession(): null | string {
  try {
    const value = window.localStorage.getItem(HUD_SESSION_KEY)

    // Read-and-clear: a stale id from a previous HUD would otherwise pull the
    // main window onto a conversation the user has since navigated away from.
    window.localStorage.removeItem(HUD_SESSION_KEY)

    return value || null
  } catch {
    return null
  }
}

/**
 * Take the session back onto this window's transport.
 *
 * Awaited, not fired off: the whole point is the rebind, so "the handoff is
 * done" has to mean the resume returned. A caller that did not wait would report
 * success while the socket was still the HUD's.
 */
async function rehomeSession(reported: null | string): Promise<void> {
  const { $activeStoredSessionId, openSession } = await import('@/store/session')

  // Whatever the HUD ended on, or — if it never reported, or storage is
  // unavailable — whatever this window still has selected. Re-homing the
  // window's OWN session is not a no-op: the HUD held the binding for it.
  const target = reported ?? $activeStoredSessionId.get()

  if (!target) {
    return
  }

  // The HUD may have typed or sent since this window last read the stash, and
  // the composer's per-session swap only re-consults it when the scope CHANGES
  // — which, for the same session, it never does.
  reloadPersistedDrafts()

  if (target !== $activeStoredSessionId.get()) {
    // A conversation this window was not on. Route to it first so the shell is
    // already showing the right chat when the slice binds.
    navigateTo(sessionRoute(target))
  }

  await openSession(target, { forceResume: true })

  requestComposerDraftSync('reload')
}

let installed = false

/**
 * Whether the HUD that is up right now was summoned by THIS window.
 *
 * Two full app windows can be open at once (⌘⇧N, or "New window" in the command
 * palette), and the close arrives natively — every window hears it. A listener
 * armed by an earlier HUD stays armed, so with no owner both windows would
 * re-home the next HUD that anybody opens: they would race
 * `takeReportedHudSession` (one gets the id, the other falls back to its own
 * selection), both force a resume, and whichever landed first ends up deaf —
 * precisely the failure this module exists to repair. Worse, the window that had
 * nothing to do with the HUD would NAVIGATE to its conversation.
 *
 * So the winner is defined: the window that summoned it takes it back. Only one
 * window can have summoned the live HUD — `toggleHud` dismisses one that is
 * already up instead of summoning a second, and there is only ever one `sat-hud`.
 */
let summoned = false

/** Main-window side: this window put the HUD on screen, so this window owes its
 *  session a way home. Called from `openHud` only once the window really opened —
 *  a failed summon leaves nothing to reclaim. */
export function noteHudSummoned(): void {
  summoned = true
}

/**
 * Main-window side: reclaim the session when the HUD goes away.
 *
 * Installed lazily from `openHud()` rather than wired into a component tree, for
 * two reasons. The window that summons the HUD is by definition the window that
 * must take the session back, so the summoning call site is where the
 * responsibility actually lives; and an app that never opens a HUD pays nothing.
 *
 * Idempotent — `openHud` runs on every summon, and stacking listeners would
 * re-home once per HUD ever opened.
 */
export function installHudHandoff(): void {
  // A satellite never summons another, so this only ever runs in a window that
  // can genuinely own a session. The guard is belt-and-braces against a future
  // caller: a HUD listening for its own destruction would be re-homing onto a
  // transport that is going away.
  if (installed || !IS_TAURI || isSatelliteWindow()) {
    return
  }

  installed = true

  void listen<string>(SATELLITE_WINDOW_CLOSED_EVENT, event => {
    if (satelliteSurfaceFromLabel(event.payload ?? '') !== HUD_SURFACE || !summoned) {
      return
    }

    // Cleared before the re-home, not after: the ownership is spent on this
    // close, and a second close with no summon in between belongs to nobody.
    summoned = false

    // Consumed here, synchronously, rather than inside the async re-home: the
    // read-and-clear must happen on this event, not after an await that a second
    // close could interleave with.
    void rehomeSession(takeReportedHudSession()).catch(err => {
      // The forced resume reports its own failure (`store/session.ts` notifies
      // on a failed reclaim and resolves), so anything landing here is the
      // re-home around it — a cold hydrate that rejected, say. Surfacing it
      // matters: a silently failed handoff looks exactly like a working one
      // until the next reply never arrives.
      notifyError(err, 'Could not take the conversation back from the HUD')
    })
  })
}

/** Test seam: forget the installed listener, the ownership and any stashed session. */
export function resetHudHandoff(): void {
  installed = false
  summoned = false
  reportHudSession(null)
}
