/**
 * Satellite windows (MJXHRM-55) — the substrate a summonable second surface
 * sits on. The thing worth testing is the lifecycle, not the pixels: nothing may
 * be left running after the window that summoned it goes away, and — since
 * MJXHRM-382 — the frontend must not build the window itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'

interface FakeWindow {
  close: ReturnType<typeof vi.fn>
  label: string
}

const live = new Map<string, FakeWindow>()
/** Every `open_satellite_window` invoke, with the arguments it carried. */
const opens: Array<Record<string, unknown>> = []
let closeRequested: ((event: { preventDefault: () => void }) => Promise<void> | void) | null = null
const mainClose = vi.fn()
/** The two window commands the close guard ends in. Rust ones, not ACL grants —
 *  `core:window:allow-hide` and `-destroy` are both absent from
 *  `capabilities/default.json`, which is the whole reason the guard cannot fall
 *  through to the JS wrapper's `destroy()`. */
const hideThis = vi.fn()
const closeThis = vi.fn()

/** The satellites Rust's `SATELLITES` registry knows. A surface outside it is
 *  refused there, which is what makes `sat-*` a namespace the webview cannot
 *  write into. */
const KNOWN = new Set(['hud', 'quick'])

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'hide_this_window') {
      hideThis(args)

      return undefined
    }

    if (command === 'close_this_window') {
      closeThis(args)

      return undefined
    }

    if (command === 'set_background_mode') {
      return args.on
    }

    if (command !== 'open_satellite_window') {
      throw new Error(`unexpected command ${command}`)
    }

    opens.push(args)

    const surface = String(args.surface)

    if (!KNOWN.has(surface)) {
      throw new Error(`unknown surface ${surface}`)
    }

    const label = `sat-${surface}`
    const fresh = !live.has(label)

    live.set(label, {
      close: vi.fn(async () => {
        live.delete(label)
      }),
      label
    })

    // Rust answers with a grant only for a FRESH attach; a satellite that merely
    // came forward keeps the one already written down for it.
    return { grant: fresh ? { backend: 'layer-shell', label, outputSized: true } : null, label }
  }
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class WebviewWindow {
    constructor() {
      // What the ACL now does: `core:webview:allow-create-webview-window` is not
      // in `capabilities/default.json` any more, so a webview that tries to
      // build a window is refused. The mock refuses too — a mock that granted it
      // would let a regression back in without a single test noticing.
      throw new Error('webview.create_webview_window not allowed')
    }

    static async getByLabel(label: string) {
      return live.get(label) ?? null
    }
  }

  return {
    getCurrentWebviewWindow: () => ({
      close: mainClose,
      // `main` is the ONLY label background mode hides — see
      // `backgroundCloseTakesOver`. A hidden `instance-2` would have nothing able
      // to reveal it.
      label: 'main',
      onCloseRequested: async (handler: (event: { preventDefault: () => void }) => Promise<void> | void) => {
        closeRequested = handler

        return () => undefined
      }
    }),
    WebviewWindow
  }
})

// The native close announcement (`RunEvent::WindowEvent::Destroyed` in
// src-tauri/src/lib.rs). Captured rather than stubbed away: a satellite the
// compositor killed is the ONLY way the frontend hears about it, and what the
// summoning window does with it is the thing under test.
const eventListeners = new Map<string, (event: { payload: unknown }) => void>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    eventListeners.set(event, handler)

    return () => eventListeners.delete(event)
  }
}))

// A satellite needs a real second window, so the module stands down off desktop.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

// One module instance for the file: the teardown hook installs once per window
// in the real app too, and re-importing under a `vi.resetModules()` loses the
// dynamic-import mock for the Tauri module.
const {
  closeAllSatelliteWindows,
  closeSatelliteWindow,
  isSatelliteWindowOpen,
  openSatelliteWindow,
  SATELLITE_WINDOW_CLOSED_EVENT,
  satelliteSurfaceGrant,
  sweepStaleSurfaceGrants,
  toggleSatelliteWindow
} = await import('./windows')

const { $backgroundMode } = await import('./background-mode')

/** The key `rememberSurfaceGrant` writes. */
const GRANT_KEY = 'hermes:surface-grant:hud'

/** What Rust emits when a window is DESTROYED, however it was destroyed. */
function emitNativeClose(label: string): void {
  eventListeners.get(SATELLITE_WINDOW_CLOSED_EVENT)?.({ payload: label })
}

// The teardown hook is installed off the first open and not awaited by it.
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(async () => {
  await closeAllSatelliteWindows()
  live.clear()
  opens.length = 0
  mainClose.mockClear()
  hideThis.mockClear()
  closeThis.mockClear()
  $backgroundMode.set(false)
  window.localStorage.removeItem(GRANT_KEY)
})

describe('satellite windows', () => {
  it('asks Rust for the window instead of building one', async () => {
    expect(await openSatelliteWindow('hud')).toBe('sat-hud')

    // The whole of MJXHRM-382's second pass: the label, the URL and the geometry
    // are Rust's, so the only things that cross are which surface and where in
    // the app it opens. A `new WebviewWindow(...)` here would throw — see the
    // mock, which models the ACL that no longer grants it.
    expect(opens).toEqual([{ route: null, surface: 'hud' }])
  })

  it('carries an in-app route for Rust to place after the hash', async () => {
    await openSatelliteWindow('hud', '/settings')

    expect(opens[0].route).toBe('/settings')
  })

  it('records the grant a fresh attach answers with', async () => {
    await openSatelliteWindow('hud')

    // The satellite cannot ask for itself — attaching happens before its JS
    // exists — so the answer has to be written down where it can read it.
    expect(satelliteSurfaceGrant('hud')?.outputSized).toBe(true)
  })

  it('keeps the grant when a satellite already up is merely brought forward', async () => {
    await openSatelliteWindow('hud')
    expect(await openSatelliteWindow('hud')).toBe('sat-hud')

    // Rust answers a re-focus with no grant; overwriting the stored one with
    // null would leave the HUD laying itself out as a plain window.
    expect(satelliteSurfaceGrant('hud')?.outputSized).toBe(true)
  })

  it('refuses a surface name that would not survive a label or a URL', async () => {
    expect(await openSatelliteWindow('Quick Entry')).toBeNull()
    expect(await openSatelliteWindow('../evil')).toBeNull()
    expect(opens).toHaveLength(0)
  })

  it('reports a surface Rust does not know as not opened', async () => {
    // Well-formed as a label, absent from the registry — the case that stops a
    // caller minting a satellite of its own.
    expect(await openSatelliteWindow('evil')).toBeNull()
    expect(opens).toHaveLength(1)
    expect(live.size).toBe(0)
  })

  it('toggles: summon, then dismiss', async () => {
    expect(await toggleSatelliteWindow('hud')).toBe(true)
    expect(await toggleSatelliteWindow('hud')).toBe(false)
    expect(live.has('sat-hud')).toBe(false)
  })

  it('takes its satellites down with the window that summoned them', async () => {
    await openSatelliteWindow('hud')
    await flush()

    expect(closeRequested).not.toBeNull()

    const preventDefault = vi.fn()
    await closeRequested?.({ preventDefault })

    // The satellite goes first — otherwise the app keeps running with nothing
    // but an always-on-top orphan on screen — and only then does the window go.
    expect(preventDefault).toHaveBeenCalled()
    expect(live.has('sat-hud')).toBe(false)
    expect(closeThis).toHaveBeenCalled()
  })

  // This used to assert `preventDefault` was NOT called, and called that
  // "standing aside". It was not standing aside — it was a dead end. Tauri's core
  // prevents the close for any window that has a JS close-requested listener
  // (tauri/src/manager/window.rs) and the JS wrapper's only fallback is
  // `destroy()`, which `capabilities/default.json` does not grant. So a window
  // that had ever summoned a satellite could not be closed by its titlebar button
  // at all, and the old test pinned that as the contract.
  it('closes through Rust when there is nothing left to tear down', async () => {
    await openSatelliteWindow('hud')
    await flush()
    await closeSatelliteWindow('hud')

    const preventDefault = vi.fn()
    await closeRequested?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalled()
    expect(closeThis).toHaveBeenCalled()
    // Never the webview's own `close()`: it re-emits CloseRequested, which this
    // very handler would intercept again, forever.
    expect(mainClose).not.toHaveBeenCalled()
  })

  // Background mode (MJXHRM-436): the window is not going away, it is going out
  // of sight. A hidden window still EXISTS, so "a satellite may never outlive its
  // summoner" is not violated — and the HUD staying up is the entire point, since
  // it has to remain summonable with no UI on screen.
  describe('with background mode on', () => {
    it('hides the window and keeps the satellites', async () => {
      await openSatelliteWindow('hud')
      await flush()
      $backgroundMode.set(true)

      const preventDefault = vi.fn()
      await closeRequested?.({ preventDefault })

      expect(preventDefault).toHaveBeenCalled()
      // No label crosses the IPC boundary: Rust resolves the window to hide from
      // the calling webview (MJXHRM-382), which is the same reason
      // `core:window:allow-hide` is withheld.
      expect(hideThis).toHaveBeenCalledWith(undefined)
      // The two things a hide must NOT do. Tearing the HUD down would leave the
      // chord summoning nothing; destroying the window would take the gateway
      // socket and every in-flight turn with it.
      expect(live.has('sat-hud')).toBe(true)
      expect(closeThis).not.toHaveBeenCalled()
      expect(mainClose).not.toHaveBeenCalled()
    })

    it('goes back to closing the moment the preference is off', async () => {
      await openSatelliteWindow('hud')
      await flush()
      $backgroundMode.set(true)

      await closeRequested?.({ preventDefault: vi.fn() })
      expect(hideThis).toHaveBeenCalledTimes(1)

      $backgroundMode.set(false)
      await closeRequested?.({ preventDefault: vi.fn() })

      expect(hideThis).toHaveBeenCalledTimes(1)
      expect(live.has('sat-hud')).toBe(false)
      expect(closeThis).toHaveBeenCalled()
    })
  })

  // `hermes:surface-grant:<surface>` is localStorage, so it outlives the PROCESS.
  // Tray -> Quit takes the whole app down with nothing alive to hear the native
  // close event, and the next run's HUD would read a grant negotiated for a
  // window that died on a different compositor.
  describe('the boot sweep for stale surface grants', () => {
    it('drops a grant whose window is gone', async () => {
      await openSatelliteWindow('hud')
      await flush()
      expect(satelliteSurfaceGrant('hud')).not.toBeNull()

      // What a killed process leaves: the key on disk, no window behind it, and
      // no event ever emitted.
      live.delete('sat-hud')
      await sweepStaleSurfaceGrants()

      expect(satelliteSurfaceGrant('hud')).toBeNull()
    })

    it('leaves a grant alone while its window is up', async () => {
      await openSatelliteWindow('hud')
      await flush()

      // An instance window booting beside a live HUD runs this too. Liveness is
      // asked of the window system, not assumed from "we just booted".
      await sweepStaleSurfaceGrants()

      expect(satelliteSurfaceGrant('hud')).not.toBeNull()
    })
  })

  it('reports a window the user closed as gone', async () => {
    await openSatelliteWindow('hud')
    expect(await isSatelliteWindowOpen('hud')).toBe(true)

    live.delete('sat-hud')
    expect(await isSatelliteWindowOpen('hud')).toBe(false)
  })

  // A satellite the COMPOSITOR closed runs no JS in it at all — no `pagehide`,
  // no unmount, no `closeSatelliteWindow`. Everything that close is supposed to
  // clean up therefore has to hang off the native announcement instead
  // (MJXHRM-374).
  describe('a satellite closed natively', () => {
    it('stops being claimed by the window that summoned it', async () => {
      await openSatelliteWindow('hud')
      await openSatelliteWindow('quick')
      await flush()

      // The compositor takes the HUD: gone from the window system, no JS ran.
      // Quick Entry is untouched and still claimed.
      live.delete('sat-hud')
      emitNativeClose('sat-hud')

      const quick = live.get('sat-quick')

      await closeRequested?.({ preventDefault: vi.fn() })

      // The teardown reaches only what is still claimed. A window still on the
      // list would have its `close()` called on a window that no longer exists —
      // and, before the native announcement existed, every later quit paid that
      // round trip.
      expect(quick?.close).toHaveBeenCalled()
      expect(closeThis).toHaveBeenCalled()
    })

    it('clears the surface grant it left on disk', async () => {
      await openSatelliteWindow('hud')
      await flush()

      expect(satelliteSurfaceGrant('hud')).not.toBeNull()

      live.delete('sat-hud')
      emitNativeClose('sat-hud')

      // localStorage outlives the process: a grant left behind here is read by
      // the NEXT run's HUD, which lays itself out for a surface negotiated on a
      // machine/compositor that may no longer be the one it is on.
      expect(satelliteSurfaceGrant('hud')).toBeNull()
      expect(window.localStorage.getItem(GRANT_KEY)).toBeNull()
    })

    it('ignores a close that is not a satellite', async () => {
      await openSatelliteWindow('hud')
      await flush()

      // Every window hears this event; only `sat-*` labels are ours to act on.
      emitNativeClose('tile-abc')
      emitNativeClose('main')

      expect(satelliteSurfaceGrant('hud')).not.toBeNull()

      const preventDefault = vi.fn()
      await closeRequested?.({ preventDefault })
      expect(preventDefault).toHaveBeenCalled()
    })
  })
})
