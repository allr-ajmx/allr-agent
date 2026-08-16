/**
 * Summoning and dismissing Quick Entry (MJXHRM-384).
 *
 * Everything about the WINDOW belongs to `store/windows.ts` (the satellite
 * lifecycle) and, since MJXHRM-382, to the Rust registry it opens through — the
 * webview cannot create windows at all. What is left here is this surface's own
 * business: where on the screen it lands, and the one moment of the handoff —
 * arming the primary window's bridge before the quick window exists, so a
 * prompt typed a fraction of a second later has somewhere to land.
 */

import { IS_DESKTOP } from '@/lib/platform'
import { $quickEntryEnabled } from '@/store/quick-entry'
import { closeSatelliteWindow, isSatelliteWindowOpen, openSatelliteWindow } from '@/store/windows'

/** The surface id, and therefore the `?win=` flag and the `sat-quick` label. */
export const QUICK_ENTRY_SURFACE = 'quick'

// Compact capture surface, desktop's dimensions kept: wide enough for a
// sentence, short enough to read as a HUD rather than a window. The height
// covers the composer row plus the session-target picker row; nothing here ever
// grows the OS window.
//
// These are the numbers the window is BUILT at, which is Rust's `SATELLITES`
// registry — they are repeated here because the placement below has to know how
// big the window is to centre it, and must stay in step with that entry.
export const QUICK_ENTRY_WIDTH = 640
export const QUICK_ENTRY_HEIGHT = 168

/** Spotlight-ish placement: a comfortable fraction down from the top of the
 *  work area rather than dead centre, which reads as a dialog. */
export const QUICK_ENTRY_TOP_FRACTION = 0.22

/** A rectangle in physical pixels — a monitor's work area, or a window. */
export interface QuickEntryRect {
  height: number
  width: number
  x: number
  y: number
}

/**
 * Where the quick window opens on a given work area: horizontally centred, a
 * fraction down from the top, and clamped so it stays fully inside the area on
 * small or oddly-shaped displays.
 *
 * Ported from desktop `electron/quick-entry.ts`'s `quickEntryWindowBounds`, less
 * the size half — a Tauri window is created at its size and only ever moved.
 * Pure and unit-tested: an off-screen capture surface is a feature that silently
 * does nothing, which is the worst failure this window has.
 */
export function quickEntryWindowPosition(
  workArea: QuickEntryRect,
  size: { height: number; width: number }
): { x: number; y: number } {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)

  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const maxY = workArea.y + workArea.height - height
  const y = Math.round(Math.min(Math.max(workArea.y, workArea.y + workArea.height * QUICK_ENTRY_TOP_FRACTION), maxY))

  return { x, y }
}

/**
 * Put the window where the user is looking: the monitor under the POINTER, not
 * the one the app happens to be on. A capture surface summoned from inside
 * another application has to appear where that application is.
 *
 * Best-effort and deliberately not awaited by the summon: the window is already
 * up and usable at whatever position the window system chose, so a platform that
 * refuses `cursorPosition` or `setPosition` loses the placement, not the
 * feature.
 *
 * KNOWN GAP: the window is created visible (the satellite substrate only builds
 * hidden for `floating` surfaces), so on a multi-monitor setup it can be seen to
 * hop from the window system's default position to this one.
 */
async function placeQuickEntryWindow(label: string): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')

    const { availableMonitors, currentMonitor, cursorPosition, monitorFromPoint, PhysicalPosition } =
      await import('@tauri-apps/api/window')

    const win = await WebviewWindow.getByLabel(label)

    if (!win) {
      return
    }

    const cursor = await cursorPosition().catch(() => null)

    const monitor =
      (cursor ? await monitorFromPoint(cursor.x, cursor.y).catch(() => null) : null) ??
      (await currentMonitor().catch(() => null)) ??
      (await availableMonitors().catch(() => []))[0]

    if (!monitor) {
      return
    }

    // A monitor's work area is physical pixels; the spec's width/height are
    // logical, which is the same number only at scale 1.
    const scale = monitor.scaleFactor || 1

    const { x, y } = quickEntryWindowPosition(
      {
        height: monitor.workArea.size.height,
        width: monitor.workArea.size.width,
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y
      },
      { height: QUICK_ENTRY_HEIGHT * scale, width: QUICK_ENTRY_WIDTH * scale }
    )

    await win.setPosition(new PhysicalPosition(x, y))
  } catch (err) {
    console.warn('[quick-entry] could not place the window', err)
  }
}

/**
 * Whether Quick Entry can be summoned here at all.
 *
 * Desktop-only, the same gate the global-shortcut plugin itself sits behind
 * (`src-tauri/src/lib.rs`): neither mobile OS lets an app claim a machine-wide
 * chord, and a capture surface with no way to summon it is not a feature.
 */
export function canUseQuickEntry(): boolean {
  return IS_DESKTOP
}

/** Summon it. False when the platform can't, or the user turned it off. */
export async function openQuickEntry(): Promise<boolean> {
  if (!canUseQuickEntry() || !$quickEntryEnabled.get()) {
    return false
  }

  // Arm the return trip BEFORE the window exists. The quick window sends its
  // hello the moment it mounts, and a bridge installed after that would answer
  // nothing — leaving a window that shows "not connected" over a live gateway.
  //
  // Imported here rather than at module scope so that holding a reference to
  // this window's geometry does not drag the chat and session stores in behind
  // it — the same reason `hud/handoff.ts` defers `@/store/session`.
  const { installQuickEntryBridge } = await import('./bridge')

  installQuickEntryBridge()

  const label = await openSatelliteWindow(QUICK_ENTRY_SURFACE)

  if (!label) {
    return false
  }

  void placeQuickEntryWindow(label)

  return true
}

/** Dismiss it. Callable from either window — the quick window's own Escape and
 *  the chord both land here. */
export async function closeQuickEntry(): Promise<void> {
  await closeSatelliteWindow(QUICK_ENTRY_SURFACE)
}

/** Summon or dismiss — the shape a hotkey wants. Returns whether it is now up. */
export async function toggleQuickEntry(): Promise<boolean> {
  if (await isSatelliteWindowOpen(QUICK_ENTRY_SURFACE)) {
    await closeQuickEntry()

    return false
  }

  return openQuickEntry()
}
