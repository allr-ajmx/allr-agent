import { describe, expect, it } from 'vitest'

import {
  QUICK_ENTRY_HEIGHT,
  QUICK_ENTRY_SATELLITE,
  QUICK_ENTRY_TOP_FRACTION,
  QUICK_ENTRY_WIDTH,
  quickEntryWindowPosition
} from './quick-entry'

const SIZE = { height: QUICK_ENTRY_HEIGHT, width: QUICK_ENTRY_WIDTH }

describe('quickEntryWindowPosition', () => {
  it('centres horizontally and sits a fraction down from the top', () => {
    const area = { height: 1080, width: 1920, x: 0, y: 0 }

    expect(quickEntryWindowPosition(area, SIZE)).toEqual({
      x: (1920 - QUICK_ENTRY_WIDTH) / 2,
      y: Math.round(1080 * QUICK_ENTRY_TOP_FRACTION)
    })
  })

  it('follows a monitor that is not at the origin — the second display counts', () => {
    const area = { height: 1080, width: 1920, x: 1920, y: -200 }
    const { x, y } = quickEntryWindowPosition(area, SIZE)

    expect(x).toBe(1920 + (1920 - QUICK_ENTRY_WIDTH) / 2)
    expect(y).toBe(Math.round(-200 + 1080 * QUICK_ENTRY_TOP_FRACTION))
  })

  it('respects a work area inset by a taskbar rather than the whole screen', () => {
    // A 40px top panel: the window must start below it, never under it.
    const { y } = quickEntryWindowPosition({ height: 1040, width: 1920, x: 0, y: 40 }, SIZE)

    expect(y).toBeGreaterThanOrEqual(40)
  })

  it('keeps the window fully inside a work area shorter than the window itself', () => {
    const area = { height: 120, width: 400, x: 0, y: 0 }
    const { x, y } = quickEntryWindowPosition(area, SIZE)

    // Clamped to the area's own extent — an off-screen capture surface is a
    // feature that silently does nothing.
    expect(y).toBe(0)
    expect(x).toBe(0)
  })

  it('scales with the size it is given, so a HiDPI physical size still lands', () => {
    const area = { height: 2160, width: 3840, x: 0, y: 0 }
    const { x } = quickEntryWindowPosition(area, { height: QUICK_ENTRY_HEIGHT * 2, width: QUICK_ENTRY_WIDTH * 2 })

    expect(x).toBe((3840 - QUICK_ENTRY_WIDTH * 2) / 2)
  })
})

describe('QUICK_ENTRY_SATELLITE', () => {
  it('describes a frameless, always-on-top capture surface off the taskbar', () => {
    expect(QUICK_ENTRY_SATELLITE).toEqual({
      alwaysOnTop: true,
      decorations: false,
      height: QUICK_ENTRY_HEIGHT,
      resizable: false,
      skipTaskbar: true,
      surface: 'quick',
      transparent: true,
      width: QUICK_ENTRY_WIDTH
    })
  })

  it('asks for no floating surface — an ordinary focused window is the point', () => {
    // The HUD needs a layer-shell overlay because it types while another app
    // keeps focus. Quick Entry takes the keyboard outright and then leaves, so
    // requesting one would only add a platform that can degrade.
    expect(QUICK_ENTRY_SATELLITE.floating).toBeUndefined()
  })
})
