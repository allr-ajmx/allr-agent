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
import { surfaceCapabilities } from '@/lib/surface'
import { requestComposerDraftSync } from '@/store/composer'
import {
  closeSatelliteWindow,
  HUD_SATELLITE,
  isSatelliteWindowOpen,
  openSatelliteWindow,
  type SatelliteWindowSpec
} from '@/store/windows'

/** The HUD's surface id, and therefore its `?win=` flag and label suffix. */
export const HUD_SURFACE = HUD_SATELLITE.surface

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
 *  that opens an ordinary window. */
export async function canUseHud(): Promise<boolean> {
  return (await surfaceCapabilities()).floatingSurface
}

/**
 * Summon the HUD on `sessionId` (defaulting to whatever this window is showing).
 *
 * The draft flush happens BEFORE the window exists, not after: the HUD's
 * composer reads the shared stash as it mounts, and a `storage` event racing
 * that mount would land after it has already painted an empty box.
 */
export async function openHud(sessionId: null | string = hudTargetSessionId()): Promise<boolean> {
  requestComposerDraftSync('flush')

  const spec: SatelliteWindowSpec = sessionId ? { ...HUD_SATELLITE, route: sessionRoute(sessionId) } : HUD_SATELLITE

  return (await openSatelliteWindow(spec)) !== null
}

/** Dismiss it. Callable from either window — the HUD's own exit affordance and
 *  the main window's titlebar both land here. */
export async function closeHud(): Promise<void> {
  // The HUD may be the window running this. Flushing first means its own
  // half-typed text is in the stash before it is torn down, rather than relying
  // on `pagehide` winning a race with window destruction.
  requestComposerDraftSync('flush')
  await closeSatelliteWindow(HUD_SURFACE)
}

/** Summon or dismiss — the shape a hotkey wants. Returns whether it is now up. */
export async function toggleHud(sessionId?: null | string): Promise<boolean> {
  if (await isSatelliteWindowOpen(HUD_SURFACE)) {
    await closeHud()

    return false
  }

  return openHud(sessionId ?? hudTargetSessionId())
}
