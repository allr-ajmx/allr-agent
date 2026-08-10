/**
 * A satellite that asks for a FLOATING surface (MJXHRM-213).
 *
 * The lifecycle itself is covered by `satellite-windows.test.ts`. What is new,
 * and what these cases pin, is the ORDERING — a wlr-layer-shell surface must be
 * configured before its window is realized, so the window is built hidden,
 * handed to the native layer, and only then shown. Get that backwards and the
 * HUD silently becomes an ordinary window on the one platform the whole feature
 * was built for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'
import type { SurfaceGrant } from '@/lib/surface'

/** Every call the opener makes on the window system, in order. */
const calls: string[] = []
const constructed: Array<{ label: string; options: Record<string, unknown> }> = []
const live = new Map<string, unknown>()

const attach = vi.fn(
  async (label: string, _request: unknown): Promise<null | SurfaceGrant> => ({
    alwaysOnTop: 'layer-shell',
    backend: 'layer-shell',
    degraded: [],
    interactiveRegion: 'supported',
    keyboardFocus: 'exclusive',
    label,
    outputSized: true
  })
)

vi.mock('@/lib/surface', () => ({
  attachFloatingSurface: (label: string, request: unknown) => {
    calls.push('attach')

    return attach(label, request)
  }
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class WebviewWindow {
    constructor(label: string, options: Record<string, unknown>) {
      calls.push('construct')
      constructed.push({ label, options })

      const win = {
        close: vi.fn(async () => {
          live.delete(label)
        }),
        once: (event: string, handler: (payload: { payload: unknown }) => void) => {
          if (event === 'tauri://created') {
            setTimeout(() => handler({ payload: null }), 0)
          }
        },
        setFocus: vi.fn(async () => undefined),
        show: vi.fn(async () => {
          calls.push('show')
        })
      }

      live.set(label, win)

      return win as unknown as WebviewWindow
    }

    static async getByLabel(label: string) {
      return live.get(label) ?? null
    }
  }

  return {
    getCurrentWebviewWindow: () => ({
      close: vi.fn(),
      onCloseRequested: async () => () => undefined
    }),
    WebviewWindow
  }
})

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

const { closeSatelliteWindow, HUD_SATELLITE, openSatelliteWindow, satelliteSurfaceGrant } = await import('./windows')

beforeEach(async () => {
  await closeSatelliteWindow('hud')
  calls.length = 0
  constructed.length = 0
  live.clear()
  attach.mockClear()
})

describe('a satellite that asks for a floating surface', () => {
  it('is built hidden, attached, and only then shown', async () => {
    await openSatelliteWindow(HUD_SATELLITE)

    // The whole point. `visible: true` here would realize the GtkWindow and
    // make the layer-shell attach below fail — silently, since it would still
    // leave a perfectly ordinary window on screen.
    expect(constructed[0].options.visible).toBe(false)
    expect(calls).toEqual(['construct', 'attach', 'show'])
  })

  it('does not touch the ordinary satellite path', async () => {
    await openSatelliteWindow({ surface: 'hud' })

    expect(constructed[0].options.visible).toBe(true)
    expect(calls).toEqual(['construct'])
    expect(attach).not.toHaveBeenCalled()
  })

  it('asks for an overlay it can type into, under a name rules can target', async () => {
    await openSatelliteWindow(HUD_SATELLITE)

    expect(attach).toHaveBeenCalledWith('sat-hud', {
      // Exclusive is what lets the surface host a composer while the app
      // underneath keeps focus; anything less makes the HUD a window you have
      // to click into first.
      keyboardFocus: 'exclusive',
      layer: 'overlay',
      margins: [0, 0, 96, 0],
      namespace: 'hermes:hud'
    })
  })

  it('opens transparent, which the spike settled', async () => {
    await openSatelliteWindow(HUD_SATELLITE)

    expect(constructed[0].options.transparent).toBe(true)
  })

  it('hands the grant to the surface that has to render against it', async () => {
    await openSatelliteWindow(HUD_SATELLITE)

    // The satellite cannot ask for itself — attaching happened before its JS
    // existed — so the answer has to be written down where it can read it.
    expect(satelliteSurfaceGrant('hud')?.outputSized).toBe(true)
    expect(satelliteSurfaceGrant('hud')?.backend).toBe('layer-shell')
  })

  it('still shows the window when the platform grants nothing', async () => {
    attach.mockResolvedValueOnce(null)

    expect(await openSatelliteWindow(HUD_SATELLITE)).toBe('sat-hud')

    // A degraded HUD beats no HUD, and the absent grant is what tells the
    // surface to lay itself out as an ordinary window.
    expect(calls).toEqual(['construct', 'attach', 'show'])
    expect(satelliteSurfaceGrant('hud')).toBeNull()
  })

  it('forgets the grant when the surface closes', async () => {
    await openSatelliteWindow(HUD_SATELLITE)
    await closeSatelliteWindow('hud')

    // A grant left behind would have the next open lay out for a surface that
    // no longer exists.
    expect(satelliteSurfaceGrant('hud')).toBeNull()
  })
})
