/**
 * Satellite windows (MJXHRM-55) — the substrate a summonable second surface
 * sits on. The thing worth testing is the lifecycle, not the pixels: opening
 * twice must focus rather than spawn a twin, and nothing may be left running
 * after the window that summoned it goes away.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'

interface FakeWindow {
  close: ReturnType<typeof vi.fn>
  label: string
  once: (event: string, handler: (payload: { payload: unknown }) => void) => void
  setFocus: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
}

const live = new Map<string, FakeWindow>()
const constructed: Array<{ label: string; options: Record<string, unknown> }> = []
let closeRequested: ((event: { preventDefault: () => void }) => void) | null = null
const mainClose = vi.fn()

function makeWindow(label: string): FakeWindow {
  const win: FakeWindow = {
    close: vi.fn(async () => {
      live.delete(label)
    }),
    label,
    once: (event, handler) => {
      // The real window announces creation asynchronously; mirror that so the
      // opener's await is exercised rather than short-circuited.
      if (event === 'tauri://created') {
        setTimeout(() => handler({ payload: null }), 0)
      }
    },
    setFocus: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined)
  }

  return win
}

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class WebviewWindow {
    constructor(label: string, options: Record<string, unknown>) {
      constructed.push({ label, options })
      const win = makeWindow(label)
      live.set(label, win)

      return win as unknown as WebviewWindow
    }

    static async getByLabel(label: string) {
      return live.get(label) ?? null
    }
  }

  return {
    getCurrentWebviewWindow: () => ({
      close: mainClose,
      onCloseRequested: async (handler: (event: { preventDefault: () => void }) => void) => {
        closeRequested = handler

        return () => undefined
      }
    }),
    WebviewWindow
  }
})

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
  toggleSatelliteWindow
} = await import('./windows')

// The teardown hook is installed off the first open and not awaited by it.
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(async () => {
  await closeAllSatelliteWindows()
  live.clear()
  constructed.length = 0
  mainClose.mockClear()
})

describe('satellite windows', () => {
  it('opens under a label the capability set actually grants', async () => {
    expect(await openSatelliteWindow({ surface: 'hud' })).toBe('sat-hud')

    // `sat-*` is the glob in capabilities/default.json; a label outside it would
    // spawn a webview with no JS surface at all.
    expect(constructed[0].label).toBe('sat-hud')
    // The `?win=` flag rides BEFORE the HashRouter '#', so it lands in
    // location.search — which is where satelliteSurface() reads it from.
    expect(constructed[0].options.url).toBe('index.html?win=hud')
  })

  it('carries a route after the hash', async () => {
    await openSatelliteWindow({ route: '/settings', surface: 'hud' })

    expect(constructed[0].options.url).toBe('index.html?win=hud#/settings')
  })

  it('focuses the window already up instead of spawning a twin', async () => {
    await openSatelliteWindow({ surface: 'hud' })
    expect(await openSatelliteWindow({ surface: 'hud' })).toBe('sat-hud')

    expect(constructed).toHaveLength(1)
    expect(live.get('sat-hud')?.setFocus).toHaveBeenCalled()
  })

  it('refuses a surface name that would not survive a label or a URL', async () => {
    expect(await openSatelliteWindow({ surface: 'Quick Entry' })).toBeNull()
    expect(await openSatelliteWindow({ surface: '../evil' })).toBeNull()
    expect(constructed).toHaveLength(0)
  })

  it('toggles: summon, then dismiss', async () => {
    expect(await toggleSatelliteWindow({ surface: 'hud' })).toBe(true)
    expect(await toggleSatelliteWindow({ surface: 'hud' })).toBe(false)
    expect(live.has('sat-hud')).toBe(false)
  })

  it('takes its satellites down with the window that summoned them', async () => {
    await openSatelliteWindow({ surface: 'hud' })
    await flush()

    expect(closeRequested).not.toBeNull()

    const preventDefault = vi.fn()
    await closeRequested?.({ preventDefault })

    // The close is deferred so the satellite goes first — otherwise the app
    // keeps running with nothing but an always-on-top orphan on screen.
    expect(preventDefault).toHaveBeenCalled()
    expect(live.has('sat-hud')).toBe(false)
    expect(mainClose).toHaveBeenCalled()
  })

  it('stands aside once there is nothing left to tear down', async () => {
    await openSatelliteWindow({ surface: 'hud' })
    await closeSatelliteWindow('hud')

    const preventDefault = vi.fn()
    await closeRequested?.({ preventDefault })

    // Re-entrant by design: the second close request finds an empty set and lets
    // the window go, rather than deferring forever.
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('reports a window the user closed as gone', async () => {
    await openSatelliteWindow({ surface: 'hud' })
    expect(await isSatelliteWindowOpen('hud')).toBe(true)

    live.delete('sat-hud')
    expect(await isSatelliteWindowOpen('hud')).toBe(false)
  })
})
