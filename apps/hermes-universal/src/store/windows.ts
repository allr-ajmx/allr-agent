import { supportsMultipleWindows } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'

import { AGENTS_ROUTE, COMMAND_CENTER_ROUTE, CRON_ROUTE, PROFILES_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
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
const TILE_WINDOW_FLAG = 'tile'

/** Read `?win=` once. Everything below is derived from it, so a bad/absent
 *  search string degrades to "primary window" in one place. */
function winFlag(): null | string {
  try {
    return new URLSearchParams(window.location.search).get('win')
  } catch {
    return null
  }
}

let tileWindowCache: boolean | null = null

/**
 * True in a SATELLITE window that hosts exactly one tile — the
 * `placement: 'detached'` host (MJXHRM-173).
 *
 * `?win=secondary` counts. It was the chat-only pop-out's flag before the tile
 * window generalized it, and a URL is a contract: an already-open window and any
 * stored link keep working. Only the code path behind them was unified.
 */
export function isTileWindow(): boolean {
  if (tileWindowCache !== null) {
    return tileWindowCache
  }

  const flag = winFlag()

  tileWindowCache = flag === TILE_WINDOW_FLAG || flag === SECONDARY_WINDOW_FLAG

  return tileWindowCache
}

/** The tile this window hosts, or null when the URL doesn't name one (a legacy
 *  `?win=secondary` pop-out — its target is the SESSION in the route). */
export function detachedTileId(): null | string {
  try {
    return new URLSearchParams(window.location.search).get('tile')
  } catch {
    return null
  }
}

/**
 * Whether this window should stand down from owning the app's persisted state.
 *
 * Every consumer of this asks exactly that — should I write the layout tree, the
 * session tiles, the chat bubbles, the composer pop-out? — and the answer for a
 * tile window is the same "no" it was for the chat pop-out. Hence one predicate
 * that widened rather than nine call sites renamed.
 */
export const isSecondaryWindow = isTileWindow

// --------------------------------------------------------------------------
// Activity screens (MJX-141 Android / MJX-176 iOS). Windowable surfaces (Settings,
// Command Center, Profiles, Cron) open in ONE native screen activity / scene — a separate
// WebView carrying `?win=activity` before the HashRouter `#`. The surface it shows
// is derived LIVE from the current route (`activitySurfaceForPath`), NOT a fixed
// launch marker, so switching between surfaces inside the activity is just an
// in-WebView route change. Off the native path the openers fall back to the in-app
// overlay — no behaviour change there.
// --------------------------------------------------------------------------

const ACTIVITY_WINDOW_FLAG = 'activity'

export type ActivitySurface = 'agents' | 'command-center' | 'cron' | 'profiles' | 'settings'

// The windowable surfaces, as one table: `activitySurfaceForPath` reads it to
// decide what the activity renders and `openAppRoute` reads it to decide what
// gets promoted to a native screen. Adding a surface means adding a row here —
// two parallel if-chains is how they drift apart.
const ACTIVITY_ROUTES: readonly { route: string; surface: ActivitySurface }[] = [
  { route: AGENTS_ROUTE, surface: 'agents' },
  { route: COMMAND_CENTER_ROUTE, surface: 'command-center' },
  { route: CRON_ROUTE, surface: 'cron' },
  { route: PROFILES_ROUTE, surface: 'profiles' },
  { route: SETTINGS_ROUTE, surface: 'settings' }
]

/** Matches the route itself and anything under it — a child path or a query. */
function matchesRoute(path: string, route: string): boolean {
  return path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`)
}

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
  return ACTIVITY_ROUTES.find(entry => matchesRoute(pathname, entry.route))?.surface ?? 'settings'
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

export async function openCronScreen(route: string = CRON_ROUTE): Promise<void> {
  await openActivityScreen(route)
}

export async function openAgentsScreen(route: string = AGENTS_ROUTE): Promise<void> {
  await openActivityScreen(route)
}

// Single funnel for the openers: promote the windowable surfaces to the native
// screen activity on Android, navigate everything else (and all non-Android) in
// app. Callers replace their `navigate(path)` / `navigateTo(path)` with this.
export function openAppRoute(route: string): void {
  if (ACTIVITY_ROUTES.some(entry => matchesRoute(route, entry.route))) {
    void openActivityScreen(route)

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
    .then(ok => {
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

/**
 * Open one TILE in its own native window. Returns the window's LABEL, which is
 * how a close is matched back to a tile: the label is slugged from the id, so
 * having Rust hand it back beats either side reimplementing the other's slug.
 * Null when the open failed or the platform has no second window.
 */
export async function openTileWindow(
  tileId: string,
  opts?: { sessionId?: string; watch?: boolean }
): Promise<null | string> {
  if (!tileId || !canOpenNewWindow()) {
    return null
  }

  try {
    return await invoke<string>('open_tile_window', {
      tileId,
      sessionId: opts?.sessionId ?? null,
      watch: opts?.watch ?? false
    })
  } catch (err) {
    notifyError(err, 'Could not open the tile in a new window')

    return null
  }
}

/** Close a detached tile's window by the label `openTileWindow` returned. A
 *  window the user already closed is not an error — the reattach that follows
 *  is the point, and it has already happened. */
export async function closeTileWindow(label: string): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')

    await WebviewWindow.getByLabel(label).then(win => win?.close())
  } catch {
    // Already gone, or no window system here.
  }
}

/** Fires when a detached tile's window is destroyed, with that window's label.
 *  Emitted natively (see `src-tauri/src/window.rs`) because a torn-down webview
 *  is the least reliable place to send a message from. */
export const TILE_WINDOW_CLOSED_EVENT = 'hermes://tile-window-closed'

export async function openNewWindow(): Promise<void> {
  if (!canOpenNewWindow()) {
    return
  }

  await runWindowOpen(() => invoke('open_instance_window'), 'Could not open a new window')
}
