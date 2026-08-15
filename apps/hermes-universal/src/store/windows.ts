import { supportsMultipleWindows } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'

import {
  AGENTS_ROUTE,
  COMMAND_CENTER_ROUTE,
  CRON_ROUTE,
  PROFILES_ROUTE,
  SETTINGS_ROUTE,
  WEBHOOKS_ROUTE
} from '@/app/routes'
import { requestComposerDraftSync } from '@/lib/composer-draft-bus'
import { IS_ANDROID, IS_DESKTOP, IS_IOS } from '@/lib/platform'
import { navigateTo } from '@/lib/route-nav'
import { type SurfaceGrant } from '@/lib/surface'
import { backgroundCloseTakesOver } from '@/store/background-mode'
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
 *
 * "Write as nobody" is about writes this window AUTHORS. A layout that arrives
 * inside an imported profile is authored by the archive, and the Profiles screen
 * unpacking it is an activity window, so that one write goes through regardless
 * — see the import handshake in `components/pane-shell/tree/store.ts`, which is
 * also the only thing entitled to bypass this predicate.
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

export type ActivitySurface = 'agents' | 'command-center' | 'cron' | 'profiles' | 'settings' | 'webhooks'

// The windowable surfaces, as one table: `activitySurfaceForPath` reads it to
// decide what the activity renders and `openAppRoute` reads it to decide what
// gets promoted to a native screen. Adding a surface means adding a row here —
// two parallel if-chains is how they drift apart.
const ACTIVITY_ROUTES: readonly { route: string; surface: ActivitySurface }[] = [
  { route: AGENTS_ROUTE, surface: 'agents' },
  { route: COMMAND_CENTER_ROUTE, surface: 'command-center' },
  { route: CRON_ROUTE, surface: 'cron' },
  { route: PROFILES_ROUTE, surface: 'profiles' },
  { route: SETTINGS_ROUTE, surface: 'settings' },
  { route: WEBHOOKS_ROUTE, surface: 'webhooks' }
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
    flushComposerDraftsBeforeOpen()

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

export async function openWebhooksScreen(route: string = WEBHOOKS_ROUTE): Promise<void> {
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

/**
 * Write this window's half-typed composer text into the shared draft stash
 * before a new window is built (MJXHRM-398).
 *
 * Every window kind below boots the app, and the app seeds its per-session
 * drafts from `localStorage` at module init. That stash is only ever as current
 * as the last debounced write — 400 ms (`DRAFT_PERSIST_DEBOUNCE_MS`) — so a tile
 * torn off mid-sentence used to open showing the sentence as it stood a moment
 * ago. Nothing recovered the rest either: the slot the tile left behind becomes
 * a placeholder, so this window's copy of that composer unmounts, and it does so
 * AFTER the new window has already read.
 *
 * Here, at the one choke point every native window of the app is built through,
 * rather than at each opener's caller — which is what `app/hud/hud.ts` used to
 * do alone. The bug IS "a caller forgot", and three of them had (tear-off, chat
 * pop-out, new instance window); putting it at the callers leaves the next one
 * free to forget again.
 *
 * Deliberately unaddressed: this dispatch reaches every composer mounted in THIS
 * window, and each stashes under its own session key. The window ordering the
 * new one is the window holding the text — a tear-off, a pop-out and a new
 * instance window are all requested from the surface that is showing the tile —
 * so there is nobody else to ask. Dismissal is the direction where the text is
 * in the OTHER webview, and that one goes through `requestPeerComposerFlush`.
 *
 * Synchronous, and it has to stay that way: the dispatch runs the mounted
 * composer's listener inline, which stashes, which writes `localStorage`, all
 * before the `invoke` that follows hands the window over to Rust. Awaiting
 * anything here would put the new window's mount in a race with the write it is
 * about to read.
 */
function flushComposerDraftsBeforeOpen(): void {
  requestComposerDraftSync('flush')
}

export async function openSessionInNewWindow(sessionId: string, opts?: { watch?: boolean }): Promise<void> {
  if (!sessionId || !canOpenSessionWindow()) {
    return
  }

  flushComposerDraftsBeforeOpen()

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

  flushComposerDraftsBeforeOpen()

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

  flushComposerDraftsBeforeOpen()

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
// Built by a Rust command (`open_satellite_window`, `src-tauri/src/window.rs`)
// like every other window kind here, and NOT from the frontend — the webview no
// longer holds `core:webview:allow-create-webview-window` at all (MJXHRM-382).
// That is a security boundary: a satellite is the one window kind that may be
// handed a wlr-layer-shell role (an output-sized overlay with exclusive
// keyboard focus), and while the webview could mint windows, anything running
// in it — a plugin has the app's full authority by design, see
// `contrib/runtime-loader.ts` — could create its own `sat-…` and be handed that
// role, or create `sat-hud` first and *be* the HUD the next time one was
// summoned. Which satellites exist, their geometry, and the surface request
// each may be attached with are now a Rust-side registry; this file passes a
// surface id and an in-app route, and nothing else.
// --------------------------------------------------------------------------

/** Label prefix — must match the `sat-*` glob in `capabilities/default.json`,
 *  which is what grants a satellite's webview its JS surface, and the label
 *  `open_satellite_window` builds. */
const SATELLITE_LABEL_PREFIX = 'sat'

/** The HUD's surface id. Lives here rather than in `app/hud/` because
 *  `hud/handoff.ts` needs it without importing `hud.ts` (see the note there). */
export const HUD_SURFACE = 'hud'

/** The wake indicator's surface id (MJXHRM-228) — a light over other
 *  applications, opened and closed by the state it mirrors rather than by the
 *  user. Beside the HUD's for the same reason: `app.tsx` routes on it and the
 *  driver in `app/wake-indicator/` opens it, and neither should import the
 *  other to learn its name. */
export const WAKE_INDICATOR_SURFACE = 'wake'

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

/** What `open_satellite_window` answers with: the window's label, and what the
 *  platform granted its surface — absent when the satellite asked for no
 *  floating surface, or when it was already up and merely came forward. */
interface SatelliteWindow {
  label: string
  grant: null | SurfaceGrant
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
 * the composer's cross-window draft stash relies on.
 *
 * Because it is `localStorage` it outlives the PROCESS, so "cleared on close"
 * has to hold for every way a satellite can close, including the ones that run
 * no JS in it — see `installWindowCloseGuard`, which is what makes that true.
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

/**
 * Which window a window-addressed message is for.
 *
 * `surface` is the satellite it must be (`null` = an ordinary window); `tile` is
 * the detached tile it must be hosting (`null` = it hosts no single tile). Both
 * fields, because neither alone names one window: every tile window reads
 * `surface: null` exactly like the main window does, and every satellite reads
 * `tile: null` exactly like it too.
 *
 * The one pair this cannot separate is the main window from a legacy
 * `?win=secondary` pop-out, which carries no tile id. Nothing addresses
 * `{ surface: null, tile: null }` today, and Rust has not BUILT a `secondary`
 * window since `open_session_window` started delegating to `open_tile_window`
 * (`src-tauri/src/window.rs`) — the flag survives only so an already-open window
 * and a stored link keep working.
 */
export interface WindowAddress {
  surface: null | string
  tile: null | string
}

/**
 * True when `address` names THIS window.
 *
 * Synchronous, and that is the point: every field is read off this window's own
 * URL, so a message handler can decide inline and answer in the same tick —
 * which is what makes an acknowledgement mean "the text is on disk" rather than
 * "the message arrived".
 */
export function addressesThisWindow(address: WindowAddress): boolean {
  return address.surface === satelliteSurface() && address.tile === detachedTileId()
}

/** Satellites need a real second window, so they follow the same platform gate
 *  as the other pop-outs — and a satellite never spawns another. */
export function canOpenSatelliteWindow(): boolean {
  return multiWindowSupported() && !isSatelliteWindow()
}

/**
 * Drop every trace of a satellite that is no longer on screen: this window's
 * claim on it, and the grant it published for it.
 *
 * Both halves are STATE ABOUT A WINDOW THAT NO LONGER EXISTS, and the grant half
 * is persisted — `localStorage` outlives the process, so a grant left behind is
 * read by the next run of the app.
 */
function forgetSatellite(surface: string): void {
  openedSatellites.delete(surface)
  // The grant describes a window that is going away; leaving it behind would
  // have the next open read a layout decision made for a surface that no longer
  // exists.
  rememberSurfaceGrant(surface, null)
}

/**
 * Put this window out of sight without destroying it (background mode).
 *
 * A Rust command rather than `core:window:allow-hide`, and it takes no label:
 * the window to act on is the one that called, resolved from the calling webview
 * on the Rust side. Same posture as every other window operation here
 * (MJXHRM-382) — the label of the window to act on is never a value from the
 * webview. Rust refuses from anything but `main` — see `hide_this_window` and
 * `backgroundCloseTakesOver` for why a hidden pop-out would be unreachable.
 */
export async function hideThisWindow(): Promise<void> {
  await invoke('hide_this_window')
}

/**
 * Ask Rust to resize THIS satellite's window to `height` logical pixels, and
 * answer with the height it actually applied (or null when nothing happened).
 *
 * Only the calling window's own size can be changed — the label never crosses
 * IPC (`resize_satellite_window`), and `core:window:allow-set-size` is
 * deliberately absent from `capabilities/default.json` precisely because it
 * takes any window's label as an argument.
 *
 * The `isSatelliteWindow()` refusal here is not a duplicate of Rust's: it is
 * what stops the HUD's own layout hooks from firing an IPC call every time a
 * chat surface is remeasured in the MAIN window, where those hooks also run and
 * where the answer would always be the same refusal.
 *
 * A failure is swallowed rather than notified. The only surface that calls this
 * does so from a `ResizeObserver`, so a platform that refuses would raise one
 * toast per frame — and the visible consequence is a window that does not grow,
 * which the log already explains.
 */
export async function resizeSatelliteWindow(height: number): Promise<null | number> {
  if (!isSatelliteWindow() || !Number.isFinite(height)) {
    return null
  }

  try {
    return await invoke<number>('resize_satellite_window', { height })
  } catch (err) {
    console.warn('could not resize this window', err)

    return null
  }
}

/**
 * Destroy this window for real.
 *
 * This exists because the obvious spellings do not work.
 * `getCurrentWebviewWindow().close()` re-emits `CloseRequested`, which the guard
 * below intercepts again — forever — and the `destroy()` the JS wrapper falls
 * back to needs `core:window:allow-destroy`, which `capabilities/default.json`
 * does not grant (nor does `core:window:default`, which is read-only queries
 * only). So the only way a guarded window can actually go away is Rust
 * destroying it.
 */
async function closeThisWindow(): Promise<void> {
  await invoke('close_this_window')
}

/**
 * The one `tauri://close-requested` handler this window gets, plus the satellite
 * bookkeeping that hangs off native closes.
 *
 * **Every branch calls `preventDefault`, and that is not defensive.** Tauri's
 * core calls `prevent_close()` for any window that has a JS close-requested
 * listener (`tauri/src/manager/window.rs`) and then emits the event; the JS
 * wrapper runs this handler and, if nothing prevented, calls `destroy()`. That
 * `destroy` is not in the ACL. So "return and let it close" is not a path that
 * closes anything — before this, a window that had ever opened a satellite could
 * not be closed by its titlebar button at all, because the second, re-entrant
 * pass found an empty set, stood aside, and hit the refused `destroy`. The old
 * `stands aside once there is nothing left to tear down` test asserted exactly
 * that dead end as the contract.
 *
 * The three outcomes, in order:
 *
 *  1. **Background mode** — this window is not going away, it is going out of
 *     sight. Its satellites outlive nothing (the window that summoned them is
 *     still here), so they stay, and the HUD stays summonable with no UI on
 *     screen. This is the branch that makes "close" mean "hide".
 *  2. **Satellites up** — a satellite may never outlive its summoner, so they go
 *     first and the window follows. No longer re-entrant: `closeThisWindow`
 *     destroys, so there is no second close request to service.
 *  3. **Nothing to do** — destroy.
 *
 * Installed at BOOT for any window that owns the app's persisted state, and
 * still lazily from `openSatelliteWindow` for the ones that do not (a tile
 * window can summon Quick Entry). Idempotent through `teardownInstalled`,
 * because there must be exactly one of these: JS is authoritative over the close,
 * and two handlers would race over what the close meant.
 *
 * The `SATELLITE_WINDOW_CLOSED_EVENT` listener is the other half of the
 * guarantee, and the one that is easy to miss: a satellite closed NATIVELY — the
 * compositor, the window manager, an OS close button — runs no JS teardown at
 * all, so `closeSatelliteWindow()` never happens for it. Without this, that close
 * leaks both halves of `forgetSatellite`: this window keeps claiming a satellite
 * that is gone, and — the part that outlives the process —
 * `hermes:surface-grant:<surface>` stays on disk, so the NEXT run's satellite can
 * read a grant negotiated for a window that died in a previous one. The event is
 * emitted from Rust (`src-tauri/src/lib.rs`, `RunEvent::WindowEvent::Destroyed`)
 * precisely because it must arrive whether or not the dying page ran anything.
 */
export async function installWindowCloseGuard(): Promise<void> {
  if (teardownInstalled) {
    return
  }

  teardownInstalled = true

  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const current = getCurrentWebviewWindow()

    // Installed FIRST, and deliberately: this is the guarantee that no satellite
    // outlives its summoner. The bookkeeping listener below is a correction, not
    // a safety net, so it must never be the reason this one did not get armed.
    await current.onCloseRequested(async event => {
      event.preventDefault()

      if (backgroundCloseTakesOver(current.label, ownsPersistedAppState())) {
        try {
          await hideThisWindow()
        } catch (err) {
          // The window is still on screen and the user pressed close. Saying
          // nothing would read as a dead titlebar button.
          notifyError(err, 'Could not hide this window')
        }

        return
      }

      if (openedSatellites.size > 0) {
        await closeAllSatelliteWindows()
      }

      await closeThisWindow()
    })

    const { listen } = await import('@tauri-apps/api/event')

    await listen<string>(SATELLITE_WINDOW_CLOSED_EVENT, event => {
      const surface = satelliteSurfaceFromLabel(event.payload ?? '')

      if (surface) {
        forgetSatellite(surface)
      }
    })
  } catch {
    // No window system here (web/mobile) — nothing to tear down.
  }
}

/**
 * Drop surface grants left behind by a previous run.
 *
 * `hermes:surface-grant:<surface>` is `localStorage`, so it outlives the PROCESS.
 * Every live path clears it — `forgetSatellite` on an explicit close, and the
 * native destroy event for a close that ran no JS — but neither can fire when
 * there was nothing alive to hear it: an explicit Quit from the tray takes the
 * whole process down, and a crash or a `SIGKILL` takes it down harder. The next
 * run's HUD would then read a grant negotiated for a window that died on a
 * different compositor and lay itself out for a layer surface it never got.
 *
 * Liveness is asked of the window system rather than assumed from "we just
 * booted": an instance window opening while the HUD is up boots too, and must not
 * sweep a grant that is currently in force.
 */
export async function sweepStaleSurfaceGrants(): Promise<void> {
  let surfaces: string[]

  try {
    surfaces = Object.keys(window.localStorage)
      .filter(key => key.startsWith(SURFACE_GRANT_KEY))
      .map(key => key.slice(SURFACE_GRANT_KEY.length))
  } catch {
    // Private mode / no storage: nothing was written, so nothing is stale.
    return
  }

  for (const surface of surfaces) {
    if (!(await isSatelliteWindowOpen(surface))) {
      rememberSurfaceGrant(surface, null)
    }
  }
}

/**
 * Open the satellite, or bring it forward if it is already up. Returns its
 * label, or null when the platform has no second window, the surface is not one
 * Rust knows, or the window could not be built.
 *
 * `route` is an in-app path (`/<session>`); Rust holds it to that shape and
 * places it after the HashRouter `#`. Everything else about the window — its
 * size, its chrome, and whether it gets a layer-shell role at all — comes from
 * the registry in `src-tauri/src/window.rs`, not from here.
 */
export async function openSatelliteWindow(surface: string, route?: string): Promise<null | string> {
  if (!satelliteLabel(surface) || !canOpenSatelliteWindow()) {
    return null
  }

  // After the guard, never before it: a summon that cannot happen must leave no
  // trace, and a flush would make the shared stash authoritative for a composer
  // that will never mount to read it.
  flushComposerDraftsBeforeOpen()

  try {
    const opened = await invoke<SatelliteWindow>('open_satellite_window', { route: route ?? null, surface })

    // Only a fresh attach answers with a grant; a satellite that merely came
    // forward keeps the one already written down for it.
    if (opened.grant) {
      rememberSurfaceGrant(surface, opened.grant)
    }

    openedSatellites.add(surface)
    // Claiming a satellite this window did not build still makes this window
    // responsible for it — and arms the close listener that forgets it again.
    // Idempotent: a window that owns the app's state already armed it at boot.
    void installWindowCloseGuard()

    return opened.label
  } catch (err) {
    notifyError(err, 'Could not open that window')

    return null
  }
}

/** Close a satellite. A window the user already closed is not an error — the
 *  end state is what the caller wanted. */
export async function closeSatelliteWindow(surface: string): Promise<void> {
  const label = satelliteLabel(surface)

  forgetSatellite(surface)

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

/** Summon or dismiss — the shape a hotkey wants. Returns whether it is now up. */
export async function toggleSatelliteWindow(surface: string, route?: string): Promise<boolean> {
  if (await isSatelliteWindowOpen(surface)) {
    await closeSatelliteWindow(surface)

    return false
  }

  return (await openSatelliteWindow(surface, route)) !== null
}
