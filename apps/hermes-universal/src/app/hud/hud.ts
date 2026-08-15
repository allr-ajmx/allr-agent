/**
 * Summoning and dismissing the HUD (MJXHRM-213).
 *
 * The HUD is a floating surface — a second window of the app that lives over
 * whatever the user is actually working in. It is not a pop-out of something the
 * main window shows; it is the same conversation, reached from somewhere else.
 *
 * Everything about the WINDOW belongs to `store/windows.ts` (the satellite
 * lifecycle) and everything about the SURFACE belongs to `lib/surface.ts` (the
 * native capability layer). What is left here — and it is the whole reason this
 * file exists — is the two moments of the handoff: which conversation the HUD
 * opens on, and making sure a half-typed message is written down before the
 * other window goes looking for it.
 */

import { routeSessionId, sessionRoute } from '@/app/routes'
import { requestComposerDraftSync } from '@/lib/composer-draft-bus'
import { surfaceCapabilities } from '@/lib/surface'
import { requestPeerComposerFlush } from '@/store/composer'
import {
  closeSatelliteWindow,
  HUD_SURFACE,
  isSatelliteWindow,
  isSatelliteWindowOpen,
  openSatelliteWindow
} from '@/store/windows'

import { installHudHandoff, noteHudSummoned } from './handoff'

/** The HUD's surface id, and therefore its `?win=` flag and label suffix.
 *  Re-exported so `app/hud/` call sites need not know it lives in the window
 *  store, where `handoff.ts` also reads it. */
export { HUD_SURFACE }

/**
 * Which conversation the HUD should open on: the one the summoning window is
 * looking at.
 *
 * Read from the route rather than from the chat store because the route is what
 * the HUD will be handed, and going through the same representation on both
 * sides means there is one definition of "the current session" instead of two
 * that can disagree.
 */
export function hudTargetSessionId(): null | string {
  try {
    // HashRouter: `#/<id>`. An empty or absent hash is the new-chat route.
    const path = window.location.hash.replace(/^#/, '') || '/'

    return routeSessionId(path)
  } catch {
    return null
  }
}

/** Whether this build/platform can put a floating surface on screen at all. A
 *  platform that cannot should not show the affordance rather than showing one
 *  that opens an ordinary window.
 *
 *  Read in two places for two different reasons: `useCanUseHud` hides the
 *  titlebar button, and `openHud` below refuses outright. The button is the
 *  affordance; the refusal is the part a hotkey cannot route around. */
export async function canUseHud(): Promise<boolean> {
  return (await surfaceCapabilities()).floatingSurface
}

/**
 * Summon the HUD on `sessionId` (defaulting to whatever this window is showing).
 *
 * There is no draft flush here any more, and its absence is the point. It used
 * to sit on this line, and it was the ONLY opener that had one — tearing a tile
 * off, popping a chat out and opening a new instance window all built a window
 * that reads the shared stash without writing to it first (MJXHRM-398). So the
 * flush moved to `openSatelliteWindow` and its three siblings in
 * `store/windows.ts`, where every native window of the app is actually built,
 * and it still happens BEFORE the window exists: the HUD's composer reads the
 * stash as it mounts, and a write racing that mount lands after it has already
 * painted an empty box.
 */
export async function openHud(sessionId: null | string = null): Promise<boolean> {
  // The capability gate, at the one choke point all three entry points share —
  // the titlebar button, the in-app keybind, and the OS-wide chord. Checked
  // before anything is flushed or armed, because a summon that cannot happen
  // must leave no trace: a flush here would make the HUD's composer stash the
  // authoritative draft for a window that never opens.
  if (!(await canUseHud())) {
    return false
  }

  // Arm the return trip BEFORE the window exists (MJXHRM-371). The HUD takes the
  // gateway's binding for whatever session it resumes, so this window has to be
  // listening for the close that hands it back — and a listener installed after
  // the HUD is up could miss one dismissed immediately.
  installHudHandoff()

  const opened = (await openSatelliteWindow(HUD_SURFACE, sessionId ? sessionRoute(sessionId) : undefined)) !== null

  if (opened) {
    // Claim the return trip. Armed above, OWNED here: a peer app window hears
    // the same native close, and only the window that actually put the HUD on
    // screen may act on it.
    noteHudSummoned()
  }

  return opened
}

/** Dismiss it. Callable from either window — the HUD's own exit affordance and
 *  the main window's titlebar both land here. */
export async function closeHud(): Promise<void> {
  // The HUD may be the window running this. Flushing first means its own
  // half-typed text is in the stash before it is torn down, rather than relying
  // on `pagehide` winning a race with window destruction.
  requestComposerDraftSync('flush')

  // And when it is NOT — the titlebar button, and the OS-wide chord, which the
  // global-shortcut plugin registers per PROCESS and so fires in whichever
  // window claimed it — the text at risk is in the other webview and this one
  // cannot reach it by dispatching a DOM event. Nothing there writes it down on
  // the way out either: a satellite torn down from another window runs no JS at
  // all (store/windows.ts), which is why its close is announced from Rust. So it
  // is asked, and the ask is AWAITED — the whole point is that the draft is on
  // disk before the window holding it stops existing.
  //
  // Only from a non-satellite, and only after the local flush above: this
  // window and the HUD are usually on the SAME conversation, so an unordered
  // exchange would let one window's older copy of one draft land on top of the
  // other's newer one.
  if (!isSatelliteWindow()) {
    await requestPeerComposerFlush({ surface: HUD_SURFACE, tile: null })
  }

  await closeSatelliteWindow(HUD_SURFACE)
}

/** Summon or dismiss — the shape a hotkey wants. Returns whether it is now up. */
export async function toggleHud(sessionId?: null | string): Promise<boolean> {
  if (await isSatelliteWindowOpen(HUD_SURFACE)) {
    await closeHud()

    return false
  }

  return openHud(sessionId ?? null)
}
