import { supportsMultipleWindows } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'

import { COMMAND_CENTER_ROUTE, PROFILES_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
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
// Activity screens (MJX-141 Android / MJX-176 iOS). Windowable surfaces (Settings,
// Command Center, Profiles) open in ONE native screen activity / scene — a separate
// WebView carrying `?win=activity` before the HashRouter `#`. The surface it shows
// is derived LIVE from the current route (`activitySurfaceForPath`), NOT a fixed
// launch marker, so switching between surfaces inside the activity is just an
// in-WebView route change. Off the native path the openers fall back to the in-app
// overlay — no behaviour change there.
// --------------------------------------------------------------------------

const ACTIVITY_WINDOW_FLAG = 'activity'

export type ActivitySurface = 'command-center' | 'profiles' | 'settings'

let activityWindowCache: boolean | null = null

// True when this WebView is the native screen activity (`?win=activity`). `app.tsx`
// mounts `ActivityScreenRoot` for it instead of the chat shell.
export function isActivityWindow(): boolean {
  if (activityWindowCache !== null) {
    return activityWindowCache
  }

  let result = false

  try {
    result = new URLSearchParams(window.location.search).get('win') === ACTIVITY_WINDOW_FLAG
  } catch {
    result = false
  }

  activityWindowCache = result

  return result
}

// Which surface the screen activity renders, from the current route (default
// Settings). Drives both `ActivityScreenRoot` and its nav drawer.
export function activitySurfaceForPath(pathname: string): ActivitySurface {
  if (pathname === COMMAND_CENTER_ROUTE || pathname.startsWith(`${COMMAND_CENTER_ROUTE}/`)) {
    return 'command-center'
  }

  if (pathname === PROFILES_ROUTE || pathname.startsWith(`${PROFILES_ROUTE}/`)) {
    return 'profiles'
  }

  return 'settings'
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

// Open a windowable surface at `route`. On Android from the home shell it launches
// the native screen activity there; INSIDE the activity it just navigates (instant
// surface switch — the activity renders by route); everywhere else it navigates to
// the in-app overlay. Optimistic: a failed invoke degrades to the overlay.
async function openActivityScreen(route: string): Promise<void> {
  if (IS_ANDROID && !isActivityWindow()) {
    try {
      await invoke('open_screen_window', { route })

      return
    } catch (err) {
      console.warn('open_screen_window failed; falling back to in-app overlay', err)
    }
  }

  navigateTo(route)
}

// Thin per-surface wrappers (kept for call-site clarity + existing imports). `route`
// is the full in-app path, so deep-links (`/settings/providers`, `/command-center?
// section=system`) survive both the native and the overlay paths.
export async function openSettingsScreen(route: string = SETTINGS_ROUTE): Promise<void> {
  await openActivityScreen(route)
}

export async function openSystemScreen(route: string = COMMAND_CENTER_ROUTE): Promise<void> {
  await openActivityScreen(route)
}

export async function openProfilesScreen(route: string = PROFILES_ROUTE): Promise<void> {
  await openActivityScreen(route)
}

// Single funnel for the openers: promote the windowable surfaces to the native
// screen activity on Android, navigate everything else (and all non-Android) in
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

  if (route === PROFILES_ROUTE || route.startsWith(`${PROFILES_ROUTE}/`)) {
    void openProfilesScreen(route)

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
