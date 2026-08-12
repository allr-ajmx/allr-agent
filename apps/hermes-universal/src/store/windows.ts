import { supportsMultipleWindows } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'

import { AGENTS_ROUTE, COMMAND_CENTER_ROUTE, CRON_ROUTE, PROFILES_ROUTE, SETTINGS_ROUTE } from '@/app/routes'
import { IS_ANDROID, IS_DESKTOP, IS_IOS } from '@/lib/platform'
import { navigateTo } from '@/lib/route-nav'
import { attachFloatingSurface, type SurfaceGrant, type SurfaceRequest } from '@/lib/surface'
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
 *
 * Satellites answer "no" too (MJXHRM-374). Windows of one origin share
 * `localStorage`, so a HUD that thinks it is primary does not merely hold a
 * private copy of the layout tree — it writes over the real window's, and the
 * two then fight for the rest of the session. The HUD is a summoned overlay
 * showing one conversation; it has no layout of its own to persist.
 *
 * A function rather than the old alias because `isSatelliteWindow` is declared
 * further down: the reference has to resolve at call time, not at binding time.
 */
export function isSecondaryWindow(): boolean {
  return isTileWindow() || isSatelliteWindow()
}

/**
 * Whether this window may WRITE the app's persisted state (MJXHRM-420).
 *
 * Wider than `isSecondaryWindow()` by exactly one case: the native activity
 * screens. Windows of one origin share `localStorage`, so an activity window —
 * which reads `isSecondaryWindow() === false`, because it is neither a tile nor
 * a satellite — was free to write the layout tree, the session tiles, the chat
 * bubbles and the last-session marker over the real window's. It hosts
 * Settings / Command Center / Profiles / Cron and has no layout of its own, so
 * every such write is someone else's state being clobbered.
 *
 * Deliberately NOT folded into `isSecondaryWindow()`. That predicate also gates
 * the initial READ of those atoms, and an activity window still wants to read:
 * exporting a profile from the Profiles screen bundles `$layoutTree`, and on
 * Android that screen is the only way to do it — so blanking the read would
 * export an empty layout every time. Read as primary, write as nobody.
 */
export function ownsPersistedAppState(): boolean {
  return !isSecondaryWindow() && !isActivityWindow()
}

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

  try {
    // The label, not `void`: the new window is about to take this session's
    // gateway stream, and closing it has to hand the stream back. `Result<String>`
    // rather than recomputing the slug here — the same contract `open_tile_window`
    // has always had, which this command delegates to.
    const label = await invoke<string>('open_session_window', { sessionId, watch: opts?.watch ?? false })

    await notePopoutSession(label, sessionId)
  } catch (err) {
    notifyError(err, 'Could not open chat in a new window')
  }
}

/**
 * Tell `store/popout-transport.ts` which conversation a new pop-out is holding,
 * so its close re-homes the stream (MJXHRM-371).
 *
 * Imported lazily on purpose: the re-home reaches the session store, and this
 * module is imported by nearly every surface in the app — a static edge would
 * drag the whole session store into all of them for a reference used only when a
 * pop-out window closes.
 */
async function notePopoutSession(label: null | string, sessionId: null | string): Promise<void> {
  if (!label || !sessionId) {
    return
  }

  const { notePopoutWindow } = await import('./popout-transport')

  notePopoutWindow(label, sessionId)
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
    const label = await invoke<string>('open_tile_window', {
      tileId,
      sessionId: opts?.sessionId ?? null,
      watch: opts?.watch ?? false
    })

    // A chat tile's window resumes the session it was handed, which moves the
    // gateway's binding onto that window's socket. A tile with no session (files,
    // terminal) holds no stream and is not recorded.
    await notePopoutSession(label, opts?.sessionId ?? null)

    return label
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

// --------------------------------------------------------------------------
// Satellite windows (MJXHRM-55)
//
// A satellite is a SECOND SURFACE of the app in its own native window — not a
// pop-out of something the main window already shows (that is a tile window
// above), but a different shape of the app entirely: summoned by a global
// hotkey, living over other applications, dismissed the moment it is done. The
// HUD (MJXHRM-213) is the first and, today, the only one.
//
// This half is deliberately content-free. It owns the label, the URL flag, the
// open/focus/close lifecycle and — the part that is easy to get wrong — the
// teardown, so a satellite can never outlive the window that summoned it.
// What the satellite RENDERS is the surface's own business: it reads
// `satelliteSurface()` and takes it from there.
//
// Built from the frontend rather than through a Rust command (the tile/instance
// path above) because a satellite is defined by its geometry — always-on-top,
// frameless, sized to its content — and that is a property of the surface, not
// of the process. `WebviewWindow`'s constructor dispatches to the main thread
// itself, so the gtk/WKWebView constraint the Rust path exists for is met.
// --------------------------------------------------------------------------

/** Label prefix — must match the `sat-*` glob in `capabilities/default.json`,
 *  which is what grants a satellite's webview its JS surface. */
const SATELLITE_LABEL_PREFIX = 'sat'

/** Surfaces opened BY THIS WINDOW. The authority on what to tear down; a window
 *  the user already closed drops out of `getByLabel` on its own. */
const openedSatellites = new Set<string>()

let teardownInstalled = false

/**
 * `?win=` values that name a window KIND rather than a satellite surface.
 *
 * `satelliteLabel` accepts any lowercase word, so without this every one of
 * these read as a satellite: an activity screen and a tile window both answered
 * `isSatelliteWindow() === true`. That silently mis-routed everything branching
 * on satellite-ness — the teardown registry, `canOpenSatelliteWindow`, the HUD
 * handoff — and made `isSecondaryWindow()` accidentally true for activity
 * windows, which blanked the layout tree they legitimately need to read.
 */
const RESERVED_WINDOW_FLAGS = new Set([SECONDARY_WINDOW_FLAG, TILE_WINDOW_FLAG, ACTIVITY_WINDOW_FLAG])

/** A surface name is part of a window label and of a URL query, so it is held to
 *  the narrow shape both accept without escaping. */
function satelliteLabel(surface: string): null | string {
  return /^[a-z][a-z0-9-]*$/.test(surface) ? `${SATELLITE_LABEL_PREFIX}-${surface}` : null
}

/**
 * Emitted by Rust to every window when a satellite's native window is destroyed,
 * carrying its LABEL (MJXHRM-371). See `src-tauri/src/window.rs`.
 *
 * Native-side rather than the closing webview's own `pagehide`: a torn-down
 * WebKitGTK view is the least reliable place to send from, and this is the
 * message the HUD handoff cannot afford to miss.
 */
export const SATELLITE_WINDOW_CLOSED_EVENT = 'hermes://satellite-window-closed'

/**
 * The surface a satellite label names, or null if it is not one.
 *
 * The inverse of `satelliteLabel`, and held to the same shape: the two must
 * agree, since one builds what the other reads back off a native event.
 */
export function satelliteSurfaceFromLabel(label: string): null | string {
  const surface = label.startsWith(`${SATELLITE_LABEL_PREFIX}-`) ? label.slice(SATELLITE_LABEL_PREFIX.length + 1) : null

  return surface && satelliteLabel(surface) === label ? surface : null
}

export interface SatelliteWindowSpec {
  /** Surface id — the `?win=` flag AND the label suffix (e.g. `hud`). */
  surface: string
  /** Route rendered inside it, after the HashRouter `#`. Defaults to the root. */
  route?: string
  width?: number
  height?: number
  /** Default true: a summoned surface that hides behind the window you were
   *  using is a surface you have to go find. */
  alwaysOnTop?: boolean
  /** Default false: satellites draw their own chrome, like every other window here. */
  decorations?: boolean
  resizable?: boolean
  /** Default true: a transient surface does not belong in the window list. */
  skipTaskbar?: boolean
  transparent?: boolean
  /**
   * Ask for a FLOATING surface — one that lives over other applications rather
   * than merely being a second window (MJXHRM-213). Present means the window is
   * built hidden, handed to the native capability layer, and only then shown;
   * absent keeps the plain always-on-top window this file has always made.
   *
   * What the platform actually granted is stashed under the surface id and read
   * with `satelliteSurfaceGrant()` — the request is not the outcome.
   */
  floating?: SurfaceRequest
}

/**
 * What each floating satellite was granted, recorded by the window that opened
 * it and passed to the satellite's own renderer through `sessionStorage`.
 *
 * It has to travel: attaching is one-shot and happens before the satellite's JS
 * exists, so its renderer cannot ask the question itself, and the answer decides
 * how it lays out (an output-sized layer surface positions its own content; a
 * plain window fills itself).
 *
 * `localStorage`, not `sessionStorage`: every window here is its own webview
 * with its own session store, so a session-scoped write would never reach the
 * satellite. Windows of one origin DO share `localStorage` — the same property
 * the composer's cross-window draft stash relies on. It is rewritten on every
 * open and cleared on close, so a stale grant from a previous run is never read.
 */
const SURFACE_GRANT_KEY = 'hermes:surface-grant:'

function rememberSurfaceGrant(surface: string, grant: null | SurfaceGrant): void {
  try {
    if (grant) {
      window.localStorage.setItem(`${SURFACE_GRANT_KEY}${surface}`, JSON.stringify(grant))
    } else {
      window.localStorage.removeItem(`${SURFACE_GRANT_KEY}${surface}`)
    }
  } catch {
    // Private mode / no storage: the satellite falls back to the plain layout,
    // which is the same thing a failed attach would have produced.
  }
}

/**
 * The grant for a floating satellite, read from inside it (or from the window
 * that opened it). Null means it is an ordinary window — either because the
 * platform granted nothing, or because nobody asked.
 */
export function satelliteSurfaceGrant(surface: string): null | SurfaceGrant {
  try {
    const raw = window.localStorage.getItem(`${SURFACE_GRANT_KEY}${surface}`)

    return raw ? (JSON.parse(raw) as SurfaceGrant) : null
  } catch {
    return null
  }
}

/**
 * The satellite surface THIS window is, or null in an ordinary window. Constant
 * for the window's life (the flag is in the URL), so a renderer can branch on it
 * once at boot rather than re-deciding per render.
 */
export function satelliteSurface(): null | string {
  const flag = winFlag()

  if (!flag || RESERVED_WINDOW_FLAGS.has(flag)) {
    return null
  }

  return satelliteLabel(flag) ? flag : null
}

export function isSatelliteWindow(): boolean {
  return satelliteSurface() !== null
}

/** Satellites need a real second window, so they follow the same platform gate
 *  as the other pop-outs — and a satellite never spawns another. */
export function canOpenSatelliteWindow(): boolean {
  return multiWindowSupported() && !isSatelliteWindow()
}

/**
 * Summoning a satellite must not be able to leave one behind: if the window that
 * opened it goes away, so do its satellites. Installed lazily on the first open
 * (an app that never summons one pays nothing) and only once.
 *
 * The re-entrant `close()` is intentional. Closing the satellites is async, so
 * the first close request is deferred; by the time we ask again the set is empty
 * and this handler stands aside.
 */
async function installSatelliteTeardown(): Promise<void> {
  if (teardownInstalled) {
    return
  }

  teardownInstalled = true

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const current = getCurrentWebviewWindow()

    await current.onCloseRequested(async event => {
      if (openedSatellites.size === 0) {
        return
      }

      event.preventDefault()
      await closeAllSatelliteWindows()
      void current.close()
    })
  } catch {
    // No window system here (web/mobile) — nothing to tear down.
  }
}

/** Open the satellite, or focus it if it is already up. Returns its label, or
 *  null when the platform has no second window or the surface name is unusable. */
export async function openSatelliteWindow(spec: SatelliteWindowSpec): Promise<null | string> {
  const label = satelliteLabel(spec.surface)

  if (!label || !canOpenSatelliteWindow()) {
    return null
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(label)

    if (existing) {
      await existing.show()
      await existing.setFocus()
      openedSatellites.add(spec.surface)

      return label
    }

    // The `?win=` flag rides BEFORE the HashRouter `#`, so it lands in
    // `location.search` — the same contract every other window flag here uses.
    const route = spec.route ? `#${spec.route}` : ''

    // A floating satellite is born HIDDEN and shown a few lines down. That
    // ordering is a hard requirement, not tidiness: a wlr-layer-shell surface
    // must be configured before its underlying window is realized, and showing
    // it first spends the only chance (see `lib/surface.ts`). A satellite with
    // no floating request keeps the old behaviour and is born visible.
    const floating = spec.floating ?? null

    const win = new WebviewWindow(label, {
      alwaysOnTop: spec.alwaysOnTop ?? true,
      decorations: spec.decorations ?? false,
      focus: true,
      height: spec.height,
      resizable: spec.resizable ?? false,
      skipTaskbar: spec.skipTaskbar ?? true,
      title: 'Hermes (MJX)',
      transparent: spec.transparent ?? false,
      url: `index.html?win=${spec.surface}${route}`,
      visible: floating === null,
      width: spec.width
    })

    // `once` rather than `then`: the event fires from the new webview, and a
    // creation that fails has to surface rather than leave a dead label behind.
    await new Promise<void>((resolve, reject) => {
      void win.once('tauri://created', () => resolve())
      void win.once('tauri://error', event => reject(new Error(String(event.payload))))
    })

    if (floating) {
      // A failed attach still shows the window. An ordinary always-on-top window
      // is a worse HUD; no HUD at all is worse than that.
      rememberSurfaceGrant(spec.surface, await attachFloatingSurface(label, floating))
      await win.show()
      await win.setFocus()
    }

    openedSatellites.add(spec.surface)
    void installSatelliteTeardown()

    return label
  } catch (err) {
    notifyError(err, 'Could not open that window')

    return null
  }
}

/** Bring an open satellite forward. False when it isn't up. */
export async function focusSatelliteWindow(surface: string): Promise<boolean> {
  const label = satelliteLabel(surface)

  if (!label) {
    return false
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const win = await WebviewWindow.getByLabel(label)

    if (!win) {
      return false
    }

    await win.show()
    await win.setFocus()

    return true
  } catch {
    return false
  }
}

/** Close a satellite. A window the user already closed is not an error — the
 *  end state is what the caller wanted. */
export async function closeSatelliteWindow(surface: string): Promise<void> {
  const label = satelliteLabel(surface)

  openedSatellites.delete(surface)
  // The grant describes a window that is going away; leaving it behind would
  // have the next open read a layout decision made for a surface that no longer
  // exists.
  rememberSurfaceGrant(surface, null)

  if (!label) {
    return
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const win = await WebviewWindow.getByLabel(label)

    await win?.close()
  } catch {
    // Already gone, or no window system here.
  }
}

export async function closeAllSatelliteWindows(): Promise<void> {
  await Promise.all([...openedSatellites].map(closeSatelliteWindow))
}

/** True when the satellite is currently up — asked of the window system, not of
 *  our bookkeeping, so a window the user closed reads as gone. */
export async function isSatelliteWindowOpen(surface: string): Promise<boolean> {
  const label = satelliteLabel(surface)

  if (!label) {
    return false
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')

    return (await WebviewWindow.getByLabel(label)) !== null
  } catch {
    return false
  }
}

/** How far below the top of the screen the HUD bar sits on a layer surface. */
export const HUD_TOP_MARGIN = 96

/**
 * The HUD's window (`app/hud/` renders into it) — named here so the surface id,
 * its geometry and its chrome are changed in one place rather than at whichever
 * call site summons it.
 *
 * `transparent` is now ON. SE-J's spike settled the question the old comment
 * here was waiting on: WebKitGTK does need its own background colour cleared and
 * not just the window's, but wry 0.55 already does that for a window built
 * `transparent` (`webkitgtk/mod.rs` sets the WebView's background to a zero-alpha
 * RGBA), and tao asks GDK for an RGBA visual in the same breath. Nothing further
 * is ours to do.
 *
 * The `floating` request is what makes this a surface rather than a small
 * window: on a wlroots compositor it becomes a wlr-layer-shell overlay with
 * exclusive keyboard focus, which is the only way a floating surface can host a
 * composer that receives keys while the app underneath keeps focus. Everywhere
 * else it degrades to an always-on-top window and says so in its grant.
 */
export const HUD_SATELLITE: SatelliteWindowSpec = {
  floating: {
    // Exclusive because the HUD's whole purpose is to be typed into from inside
    // another application. Downgraded, and reported, where it cannot be had.
    keyboardFocus: 'exclusive',
    layer: 'overlay',
    // [left, right, top, bottom] — a layer surface is positioned by insetting its
    // content, never by being moved.
    margins: [0, 0, HUD_TOP_MARGIN, 0],
    // Compositor rules can target this (blur, animation, opacity).
    namespace: 'hermes:hud'
  },
  height: 260,
  surface: 'hud',
  transparent: true,
  width: 560
}

/** Summon or dismiss — the shape a hotkey wants. Returns whether it is now up. */
export async function toggleSatelliteWindow(spec: SatelliteWindowSpec): Promise<boolean> {
  if (await isSatelliteWindowOpen(spec.surface)) {
    await closeSatelliteWindow(spec.surface)

    return false
  }

  return (await openSatelliteWindow(spec)) !== null
}
