/**
 * The floating-surface capability client (MJXHRM-213).
 *
 * The point of this layer is that a caller can NEVER be told "supported" by
 * accident — not by a call that happened not to throw, not by a backend that
 * does not know the command. These cases pin that, and pin the honesty of the
 * `read_window_below` answer, which is the difference between the model being
 * told "nothing is on screen" and being told "this platform cannot look".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'

const invoke = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

const {
  isWindowBelowUnavailable,
  readWindowBelow,
  resetSurfaceCapabilities,
  setSurfaceInteractiveRect,
  surfaceCapabilities
} = await import('./surface')

const LAYER_SHELL = {
  alwaysOnTop: 'layer-shell',
  backend: 'layer-shell',
  clickThrough: 'supported',
  floatingSurface: true,
  interactiveRegion: 'supported',
  keyboardFocus: ['none', 'on-demand', 'exclusive'],
  multiMonitorPlacement: 'supported',
  notes: [],
  platform: 'linux',
  readWindowBelow: 'supported',
  readWindowBelowSource: 'hyprland-ipc',
  rememberedGeometry: 'unsupported',
  transparency: 'supported'
}

beforeEach(() => {
  invoke.mockReset()
  resetSurfaceCapabilities()
})

describe('asking what the platform can do', () => {
  it('passes the descriptor through', async () => {
    invoke.mockResolvedValue(LAYER_SHELL)

    const caps = await surfaceCapabilities()

    expect(caps.alwaysOnTop).toBe('layer-shell')
    expect(caps.keyboardFocus).toContain('exclusive')
    expect(caps.multiMonitorPlacement).toBe('supported')
  })

  it('carries a shortfall in monitor placement through with its reason', async () => {
    // MJXHRM-417: the backend derives this from the mechanism it actually has —
    // a compositor that picks the output for us, or a session that cannot place
    // a surface at all. A client that dropped the level, or read it without the
    // note, would be back to a status nothing can act on.
    invoke.mockResolvedValue({
      ...LAYER_SHELL,
      multiMonitorPlacement: 'degraded',
      notes: ['Which monitor a floating surface opens on is the compositor’s choice here']
    })

    const caps = await surfaceCapabilities()

    expect(caps.multiMonitorPlacement).toBe('degraded')
    expect(caps.notes[0]).toContain('compositor')
  })

  it('assumes nothing about placement when it cannot ask', async () => {
    invoke.mockRejectedValue(new Error('unknown command'))

    expect((await surfaceCapabilities()).multiMonitorPlacement).toBe('unsupported')
  })

  it('asks once and reuses the answer', async () => {
    invoke.mockResolvedValue(LAYER_SHELL)

    await surfaceCapabilities()
    await surfaceCapabilities()

    // The answer depends on the compositor and the session, neither of which
    // changes while the app runs.
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('reports NO floating surface when it cannot ask', async () => {
    invoke.mockRejectedValue(new Error('unknown command'))

    const caps = await surfaceCapabilities()

    // The failure mode that matters: a backend too old to answer must not read
    // as a platform that can do everything.
    expect(caps.floatingSurface).toBe(false)
    expect(caps.alwaysOnTop).toBe('unsupported')
    expect(caps.backend).toBe('none')
    expect(caps.notes[0]).toContain('unknown command')
  })
})

describe('the interactive region', () => {
  it('forwards the rectangle and its verdict', async () => {
    invoke.mockResolvedValue('supported')

    const rect = { height: 200, width: 560, x: 10, y: 20 }

    await expect(setSurfaceInteractiveRect('sat-hud', rect)).resolves.toBe('supported')
    expect(invoke).toHaveBeenCalledWith('surface_set_interactive_rect', { label: 'sat-hud', rect })
  })

  it('reads a failure as unsupported rather than as success', async () => {
    invoke.mockRejectedValue(new Error('not realized yet'))

    await expect(setSurfaceInteractiveRect('sat-hud', null)).resolves.toBe('unsupported')
  })
})

describe('reading the window below', () => {
  it('recognises a real reading', async () => {
    invoke.mockResolvedValue({
      frontmost: { app: 'kitty', title: 'term' },
      platform: 'linux',
      window: { app: 'kitty', bounds: { height: 1080, width: 1920, x: 0, y: 0 }, id: 1, title: 'term' }
    })

    const answer = await readWindowBelow()

    expect(isWindowBelowUnavailable(answer)).toBe(false)
  })

  it('recognises an explained refusal', async () => {
    invoke.mockResolvedValue({ error: 'this is a Wayland session', platform: 'linux' })

    const answer = await readWindowBelow()

    // "Could not look" and "nothing is there" are different answers, and only
    // one of them is a lie on macOS.
    expect(isWindowBelowUnavailable(answer)).toBe(true)
  })

  it('turns a transport failure into a refusal, never an empty reading', async () => {
    invoke.mockRejectedValue(new Error('ipc gone'))

    const answer = await readWindowBelow()

    expect(isWindowBelowUnavailable(answer)).toBe(true)
    expect((answer as { error: string }).error).toContain('ipc gone')
  })
})
