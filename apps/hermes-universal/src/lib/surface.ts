/**
 * The floating-surface capability layer, frontend side (MJXHRM-213).
 *
 * Mirrors `src-tauri/src/surface/mod.rs`. A floating surface is a second window
 * that lives OVER other applications — the HUD today, the mobile chat bubble
 * (MJXHRM-351) next. Every trait it needs is supported on some platforms and not
 * others, and one of them — always-on-top — is silently ignored on Wayland while
 * reporting success, so this is a layer you QUERY rather than a set of setters
 * you call and hope.
 *
 * The rule for callers: read `floatingSurface` to decide whether to offer the
 * affordance at all, and read the GRANT returned by `attachFloatingSurface` to
 * decide how to render. Never infer a capability from a call that did not throw.
 */

import { invoke } from '@tauri-apps/api/core'

import { IS_DESKTOP } from '@/lib/platform'

/** How well one trait is supported. `degraded` means "exists, but not the way
 *  you asked" — the reason is in `notes`. */
export type Support = 'degraded' | 'supported' | 'unsupported'

/**
 * Which windowing mechanism the surface is built on. Not cosmetic: a
 * `layer-shell` surface covers the whole output and positions its own content,
 * a `toplevel` one is window-sized and fills it.
 */
export type SurfaceBackend = 'layer-shell' | 'none' | 'toplevel'

/**
 * How the surface comes to be above other windows. Deliberately not a boolean —
 * "the compositor puts it on the overlay layer" and "we asked the window manager
 * nicely" fail in different ways, and only one of them fails silently.
 */
export type AlwaysOnTop = 'app-asserted' | 'layer-shell' | 'system-managed' | 'unsupported'

/**
 * Whether the surface can take keys, and on whose terms. `exclusive` means it
 * receives them WITHOUT the compositor moving focus away from the app
 * underneath — the axis that decides whether it can host a real composer, and
 * something xdg-shell cannot express at all.
 */
export type KeyboardFocus = 'exclusive' | 'none' | 'on-demand'

export interface SurfaceCapabilities {
  /** The gate. False means: do not offer this UI here. */
  alwaysOnTop: AlwaysOnTop
  backend: SurfaceBackend
  clickThrough: Support
  floatingSurface: boolean
  /** Click-through with a HOLE — only part of the surface takes input. A
   *  different mechanism from `clickThrough`, hence a separate answer. */
  interactiveRegion: Support
  keyboardFocus: KeyboardFocus[]
  multiMonitorPlacement: Support
  /** Human-readable, one line per limitation. For diagnostics; never parsed. */
  notes: string[]
  platform: string
  readWindowBelow: Support
  readWindowBelowSource: null | string
  rememberedGeometry: Support
  transparency: Support
}

export type SurfaceLayer = 'overlay' | 'top'

export interface SurfaceRect {
  height: number
  width: number
  x: number
  y: number
}

/** What the caller wants. Every field is a request, not an instruction. */
export interface SurfaceRequest {
  keyboardFocus?: KeyboardFocus
  layer?: SurfaceLayer
  /** Content inset from each screen edge, `[left, right, top, bottom]`. This is
   *  how a layer surface is positioned — it is never moved. */
  margins?: [number, number, number, number]
  /** Compositor-visible name, so window rules can target this surface. */
  namespace: string
}

/** What the surface actually is. Render against this, not against the request. */
export interface SurfaceGrant {
  alwaysOnTop: AlwaysOnTop
  backend: SurfaceBackend
  /** One line per thing asked for and not granted. Empty means a full grant. */
  degraded: string[]
  interactiveRegion: Support
  keyboardFocus: KeyboardFocus
  label: string
  /** True when the surface covers the whole output and must position its own
   *  content — the layer-shell shape. False when it is a plain sized window. */
  outputSized: boolean
}

/** The descriptor for a platform that has no floating surface, used when the
 *  backend cannot be reached at all. Same shape as a real answer so callers
 *  never branch on "we could not ask". */
function noSurface(reason: string): SurfaceCapabilities {
  return {
    alwaysOnTop: 'unsupported',
    backend: 'none',
    clickThrough: 'unsupported',
    floatingSurface: false,
    interactiveRegion: 'unsupported',
    keyboardFocus: [],
    multiMonitorPlacement: 'unsupported',
    notes: [reason],
    platform: 'unknown',
    readWindowBelow: 'unsupported',
    readWindowBelowSource: null,
    rememberedGeometry: 'unsupported',
    transparency: 'unsupported'
  }
}

let cached: null | Promise<SurfaceCapabilities> = null

/**
 * What this platform can do for a floating surface. Cached for the process
 * lifetime — the answer depends on the compositor and the session, neither of
 * which changes while the app runs.
 */
export function surfaceCapabilities(): Promise<SurfaceCapabilities> {
  cached ??= invoke<SurfaceCapabilities>('surface_capabilities').catch(err => {
    // A backend too old to know the command is indistinguishable, from here,
    // from a platform with no surface — and both mean "do not offer it".
    return noSurface(`Could not ask the backend about floating surfaces: ${String(err)}`)
  })

  return cached
}

/** Test seam: drop the cached answer. */
export function resetSurfaceCapabilities(): void {
  cached = null
}

/**
 * Turn an already-built, still-HIDDEN window into a floating surface.
 *
 * The window must have been created with `visible: false` and must not have been
 * shown yet. That is not a style preference: a layer surface has to be
 * configured before its underlying window is realized, and once it is shown the
 * chance is gone. Show it after this resolves.
 */
export async function attachFloatingSurface(label: string, request: SurfaceRequest): Promise<null | SurfaceGrant> {
  if (!IS_DESKTOP) {
    return null
  }

  try {
    return await invoke<SurfaceGrant>('surface_attach', { label, request })
  } catch (err) {
    // A surface that could not be attached is still a window; the caller shows
    // it and gets an ordinary one. Losing the HUD entirely would be worse.
    console.warn('[surface] could not attach a floating surface:', err)

    return null
  }
}

/**
 * Restrict the surface's input to `rect`, making everything outside it
 * click-through. `null` makes the whole surface interactive again.
 *
 * On Wayland this is `wl_surface.set_input_region` — a real protocol request.
 * Where no input region exists it degrades to "interactive everywhere" and says
 * so in its return value, rather than pretending to have cut a hole.
 */
export async function setSurfaceInteractiveRect(label: string, rect: null | SurfaceRect): Promise<Support> {
  if (!IS_DESKTOP) {
    return 'unsupported'
  }

  try {
    return await invoke<Support>('surface_set_interactive_rect', { label, rect })
  } catch {
    return 'unsupported'
  }
}

/** A reading of the window underneath, in the shape the backend's
 *  `read_window_below` tool already parses. */
export interface WindowBelowReading {
  frontmost: null | { app: string; title: string }
  note?: string
  platform: string
  window: null | {
    app: string
    bounds: { height: number; width: number; x: number; y: number }
    id: number
    title: string
  }
}

export interface WindowBelowUnavailable {
  error: string
  platform: string
}

export type WindowBelowAnswer = WindowBelowReading | WindowBelowUnavailable

export function isWindowBelowUnavailable(answer: WindowBelowAnswer): answer is WindowBelowUnavailable {
  return 'error' in answer
}

/**
 * What application is underneath us. Metadata only — this never captures pixels.
 *
 * Linux/Hyprland only in this build, over the compositor's IPC socket, because
 * Wayland refuses to tell one client about another's windows and XWayland's
 * `xprop` reports a stacking order that no longer means anything. macOS and
 * Windows return an explained refusal rather than an empty answer that reads as
 * "nothing is there".
 */
export async function readWindowBelow(): Promise<WindowBelowAnswer> {
  try {
    return await invoke<WindowBelowAnswer>('read_window_below')
  } catch (err) {
    return { error: `Could not read the window below: ${String(err)}`, platform: 'unknown' }
  }
}
