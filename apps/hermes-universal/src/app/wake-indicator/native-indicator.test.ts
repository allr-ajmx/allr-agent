import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SurfaceCapabilities } from '@/lib/surface'

const h = vi.hoisted(() => ({
  caps: vi.fn(),
  open: vi.fn(async () => 'sat-wake' as null | string),
  close: vi.fn(async () => undefined),
  isSatellite: vi.fn(() => false),
  canOpen: vi.fn(() => true),
  emitState: vi.fn(async () => undefined),
  onHello: vi.fn(async (_handler: () => void) => () => undefined),
  hello: null as null | (() => void)
}))

vi.mock('@/lib/platform', () => ({ IS_DESKTOP: true, IS_TAURI: true }))
vi.mock('@/lib/surface', () => ({ surfaceCapabilities: h.caps }))
vi.mock('@/store/windows', () => ({
  WAKE_INDICATOR_SURFACE: 'wake',
  canOpenSatelliteWindow: h.canOpen,
  closeSatelliteWindow: h.close,
  isSatelliteWindow: h.isSatellite,
  openSatelliteWindow: h.open
}))
vi.mock('./channel', () => ({
  emitWakeIndicatorState: h.emitState,
  onWakeIndicatorHello: (handler: () => void) => {
    h.hello = handler

    return h.onHello(handler)
  }
}))

import { $wakeIndicator } from '@/store/wake-indicator'

import {
  $nativeWakeIndicator,
  canShowNativeWakeIndicator,
  installNativeWakeIndicator,
  nativeWakeIndicatorUnavailableReason
} from './native-indicator'

/** A session that can carry the light: layer-shell, click-through, on top. */
function capable(overrides: Partial<SurfaceCapabilities> = {}): SurfaceCapabilities {
  return {
    alwaysOnTop: 'layer-shell',
    backend: 'layer-shell',
    clickThrough: 'supported',
    floatingSurface: true,
    interactiveRegion: 'supported',
    keyboardFocus: ['none', 'exclusive'],
    multiMonitorPlacement: 'supported',
    notes: [],
    platform: 'linux-wayland',
    readWindowBelow: 'supported',
    readWindowBelowSource: 'hyprland-ipc',
    rememberedGeometry: 'unsupported',
    transparency: 'supported',
    ...overrides
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  $wakeIndicator.set('hidden')
  $nativeWakeIndicator.set(false)
  h.caps.mockReset()
  h.caps.mockResolvedValue(capable())
  h.open.mockClear()
  h.open.mockResolvedValue('sat-wake')
  h.close.mockClear()
  h.emitState.mockClear()
  h.isSatellite.mockReturnValue(false)
  h.canOpen.mockReturnValue(true)
  h.hello = null
})

describe('native wake indicator', () => {
  it('opens the light when the indicator fires and pushes the state to it', async () => {
    const stop = installNativeWakeIndicator()

    $wakeIndicator.set('detected')
    await settle()

    expect(h.open).toHaveBeenCalledWith('wake')
    expect(h.emitState).toHaveBeenLastCalledWith('detected')
    expect($nativeWakeIndicator.get()).toBe(true)

    $wakeIndicator.set('capturing')
    await settle()

    // The SAME window follows the state; a second open would be a second light.
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.emitState).toHaveBeenLastCalledWith('capturing')

    stop()
    await settle()
  })

  it('closes the light when the conversation ends', async () => {
    const stop = installNativeWakeIndicator()

    $wakeIndicator.set('detected')
    await settle()
    $wakeIndicator.set('hidden')
    await settle()

    expect(h.close).toHaveBeenCalledWith('wake')
    // The pill takes over again the moment the native light is gone.
    expect($nativeWakeIndicator.get()).toBe(false)

    stop()
    await settle()
  })

  it('closes the light when the surface that drives it goes away', async () => {
    const stop = installNativeWakeIndicator()

    $wakeIndicator.set('capturing')
    await settle()
    expect(h.close).not.toHaveBeenCalled()

    stop()
    await settle()

    expect(h.close).toHaveBeenCalledWith('wake')
  })

  // The three refusals. Each leaves `$nativeWakeIndicator` false, which is what
  // keeps the in-window pill on screen — the platform loses the better surface,
  // not the acknowledgement.
  it('refuses where a floating surface cannot stay on top', async () => {
    h.caps.mockResolvedValue(capable({ alwaysOnTop: 'unsupported', backend: 'toplevel' }))

    const stop = installNativeWakeIndicator()

    $wakeIndicator.set('detected')
    await settle()

    expect(h.open).not.toHaveBeenCalled()
    expect($nativeWakeIndicator.get()).toBe(false)
    expect(nativeWakeIndicatorUnavailableReason()).toContain('above other windows')

    stop()
    await settle()
  })

  it('refuses where clicks cannot pass through it', async () => {
    h.caps.mockResolvedValue(capable({ clickThrough: 'degraded' }))

    expect(await canShowNativeWakeIndicator()).toBe(false)
    expect(nativeWakeIndicatorUnavailableReason()).toContain('pass clicks through')
  })

  it('refuses where there is no floating surface at all', async () => {
    h.caps.mockResolvedValue(
      capable({ backend: 'none', floatingSurface: false, notes: ['Android has no floating surface yet.'] })
    )

    expect(await canShowNativeWakeIndicator()).toBe(false)
    expect(nativeWakeIndicatorUnavailableReason()).toBe('Android has no floating surface yet.')
  })

  it('refuses to summon a light from inside the light', async () => {
    h.isSatellite.mockReturnValue(true)

    expect(await canShowNativeWakeIndicator()).toBe(false)
    expect(h.caps).not.toHaveBeenCalled()
  })

  // The window's document loads after `openSatelliteWindow` resolves, so the
  // push that opened it can arrive before anything is listening. It says hello
  // when it is ready — and the answer must be the state NOW, not the one the
  // window was opened for, or a conversation that reached 'capturing' during the
  // load would breathe forever.
  it('answers the light’s hello with the live state', async () => {
    const stop = installNativeWakeIndicator()

    $wakeIndicator.set('detected')
    await settle()
    $wakeIndicator.set('capturing')
    await settle()
    h.emitState.mockClear()

    h.hello?.()
    await settle()

    expect(h.emitState).toHaveBeenCalledWith('capturing')

    stop()
    await settle()
  })

  it('shows a light that was already lit when it installed', async () => {
    $wakeIndicator.set('capturing')

    const stop = installNativeWakeIndicator()

    await settle()

    expect(h.open).toHaveBeenCalledWith('wake')
    expect(h.emitState).toHaveBeenLastCalledWith('capturing')

    stop()
    await settle()
  })
})
