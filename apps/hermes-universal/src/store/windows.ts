import { supportsMultipleWindows } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'

import { COMMAND_CENTER_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { IS_ANDROID, IS_DESKTOP, IS_IOS } from '@/lib/platform'
import { navigateTo } from '@/lib/route-nav'
import { notifyError } from '@/store/notifications'

// Ported from desktop `store/windows.ts`. Desktop opens native windows through an
// Electron preload bridge; universal invokes Rust commands (see
// `src-tauri/src/window.rs`) that build a Tauri `WebviewWindow`. A secondary
// (single-chat) window carries `?win=secondary` in its URL — placed BEFORE the
// HashRouter `#`, so it lives in `location.search` — and `?watch=1` marks a
// spectator window. `isSecondaryWindow()` scopes layout/tiles/bubbles/composer-
// popout persistence to the primary window (see its consumers in
// `pane-shell/tree/store.ts`, `session-states.ts`, `chat-bubbles.ts`, and the
// composer popout/metrics hooks).

const SECONDARY_WINDOW_FLAG = 'secondary'

let secondaryWindowCache: boolean | null = null

export function isSecondaryWindow(): boolean {
  if (secondaryWindowCache !== null) {
    return secondaryWindowCache
  }

  let result = false

  try {
    result = new URLSearchParams(window.location.search).get('win') === SECONDARY_WINDOW_FLAG
  } catch {
    result = false
  }

  secondaryWindowCache = result

  return result
}

// --------------------------------------------------------------------------
// Activity screens (MJX-141 / MJX-176). On Android, Settings and the Command
// Center open as their OWN native Activity (a separate WebView hosted by a
// registered `TauriActivity` subclass), not the in-app `fixed inset-0` overlay.
// Such a WebView carries `?win=activity&screen=<settings|command-center>` before
// the HashRouter `#`; `activityScreen()` reads it so `app.tsx` mounts the
// full-screen `ActivityScreenRoot` (Home button + that surface's nav) instead of
// the whole chat shell. Below the native path (non-Android, or a build without
// the activity registered) the openers fall back to the in-app overlay — no
// behaviour change off Android.
// --------------------------------------------------------------------------

const ACTIVITY_WINDOW_FLAG = 'activity'

export type ActivityScreen = 'command-center' | 'settings'

let activityScreenCache: ActivityScreen | null | undefined

export function activityScreen(): ActivityScreen | null {
  if (activityScreenCache !== undefined) {
    return activityScreenCache
  }

  let result: ActivityScreen | null = null

  try {
    const params = new URLSearchParams(window.location.search)

    if (params.get('win') === ACTIVITY_WINDOW_FLAG) {
      const screen = params.get('screen')

      if (screen === 'settings' || screen === 'command-center') {
        result = screen
      }
    }
  } catch {
    result = null
  }

  activityScreenCache = result

  return result
}

// Native activities are Android-only for now (iOS UIScene tracked by MJX-176),
// and never nest — an activity WebView opens its sub-routes in place rather than
// spawning yet another activity (which would also break `ActivityScreenRoot`'s
// fixed `screen`, and recurse on every settings-internal navigation).
export function canOpenActivityScreen(): boolean {
  return IS_ANDROID && activityScreen() === null
}

// The activity's native bridge (added by SettingsActivity/SystemActivity's
// `onWebViewCreate` in gen/android) — `finish()` ends the Android Activity,
// returning to MainActivity where the sessions live.
interface ActivityBridge {
  finish?: () => void
}

// The Home button returns to the home activity — MainActivity, where the sessions
// live. On Android neither `WebviewWindow.close()` (it only drops the Rust-side
// handle, leaving the Activity foregrounded) nor `set_focus` (a no-op stub) does
// this, so we call the native `finish()` bridge. Elsewhere / if the bridge is
// missing, fall back to closing the window.
export async function returnHome(): Promise<void> {
  const bridge = (window as unknown as { __hermesActivity?: ActivityBridge }).__hermesActivity

  if (bridge?.finish) {
    bridge.finish()

    return
  }

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    await getCurrentWebviewWindow().close()
  } catch (err) {
    notifyError(err, 'Could not return home')
  }
}

// Open Settings — as a native activity on Android, else the in-app overlay.
// `route` is the full in-app path (e.g. `/settings/providers`) so deep-links
// survive both paths. Optimistic: a failed invoke (activity not registered on an
// older build) silently degrades to the overlay rather than dead-ending.
export async function openSettingsScreen(route: string = SETTINGS_ROUTE): Promise<void> {
  if (canOpenActivityScreen()) {
    try {
      await invoke('open_settings_window', { route })

      return
    } catch (err) {
      console.warn('open_settings_window failed; falling back to in-app overlay', err)
    }
  }

  navigateTo(route)
}

// Open the Command Center ("System panel") — native activity on Android, else
// the in-app overlay. `route` may carry the section query (`?section=system`).
export async function openSystemScreen(route: string = COMMAND_CENTER_ROUTE): Promise<void> {
  if (canOpenActivityScreen()) {
    try {
      await invoke('open_system_window', { route })

      return
    } catch (err) {
      console.warn('open_system_window failed; falling back to in-app overlay', err)
    }
  }

  navigateTo(route)
}

// Single funnel for the openers: promote the two windowable surfaces to their
// native activity on Android, navigate everything else (and all non-Android) in
// app. Callers replace their `navigate(path)` / `navigateTo(path)` with this.
export function openAppRoute(route: string): void {
  if (route === SETTINGS_ROUTE || route.startsWith(`${SETTINGS_ROUTE}/`)) {
    void openSettingsScreen(route)

    return
  }

  if (
    route === COMMAND_CENTER_ROUTE ||
    route.startsWith(`${COMMAND_CENTER_ROUTE}/`) ||
    route.startsWith(`${COMMAND_CENTER_ROUTE}?`)
  ) {
    void openSystemScreen(route)

    return
  }

  navigateTo(route)
}

let watchWindowCache: boolean | null = null

export function isWatchWindow(): boolean {
  if (watchWindowCache !== null) {
    return watchWindowCache
  }

  let result = false

  try {
    result = new URLSearchParams(window.location.search).get('watch') === '1'
  } catch {
    result = false
  }

  watchWindowCache = result

  return result
}

// Native multi-window is supported on desktop and on iOS via UIScene (MJX-142) —
// a session opens as its own scene (side-by-side on iPad, replacing on iPhone).
// Android (Activity embedding, MJX-141) is still gated off. iOS is gated on the
// runtime `supportsMultipleWindows()` (== UIApplication.supportsMultipleScenes):
// single-scene devices fall back to the in-app view. That value resolves async, so
// we default to allowed and only flip off if the runtime reports single-scene —
// the affordance shows immediately on iPad and never flickers there.
let iosSceneCapable = true

if (IS_IOS) {
  supportsMultipleWindows()
    .then((ok) => {
      iosSceneCapable = ok
    })
    .catch(() => {
      // Leave the default: if the query fails, still offer the affordance; the
      // Rust build degrades gracefully (attaches to the main scene) if unsupported.
    })
}

function multiWindowSupported(): boolean {
  return IS_DESKTOP || (IS_IOS && iosSceneCapable)
}

// A secondary window is already a pop-out, so it never offers to open another —
// this hides the affordance in the pop-out's title menu / composer status stack.
export function canOpenSessionWindow(): boolean {
  return multiWindowSupported() && !isSecondaryWindow()
}

export function canOpenNewWindow(): boolean {
  return multiWindowSupported() && !isSecondaryWindow()
}

async function runWindowOpen(call: () => Promise<unknown>, failMessage: string): Promise<void> {
  try {
    await call()
  } catch (err) {
    notifyError(err, failMessage)
  }
}

export async function openSessionInNewWindow(sessionId: string, opts?: { watch?: boolean }): Promise<void> {
  if (!sessionId || !canOpenSessionWindow()) {
    return
  }

  await runWindowOpen(
    () => invoke('open_session_window', { sessionId, watch: opts?.watch ?? false }),
    'Could not open chat in a new window'
  )
}

export async function openNewWindow(): Promise<void> {
  if (!canOpenNewWindow()) {
    return
  }

  await runWindowOpen(() => invoke('open_instance_window'), 'Could not open a new window')
}
