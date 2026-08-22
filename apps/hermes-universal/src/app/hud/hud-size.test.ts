/**
 * The HUD's growth arithmetic (MJXHRM-438).
 *
 * None of this is observable from a running app: a window that stopped growing
 * looks the same whether the cap was applied, the request was dropped, or the
 * measurement came back zero. Every case below is chosen so the inputs would
 * produce a DIFFERENT number with the rule removed — a fixture that already
 * agrees with the expected answer is a test that cannot fail.
 */

import { describe, expect, it } from 'vitest'

import {
  HUD_BAND_MAX_PX,
  HUD_BAR_HEIGHT_PX,
  HUD_MAX_HEIGHT_PX,
  hudBandMax,
  hudWindowHeight,
  hudWindowWidth
} from './hud-size'

const open = (barPx: number, contentPx: number, bandMaxPx = 336) => ({
  bandMaxPx,
  barPx,
  contentPx,
  open: true
})

describe('hudWindowHeight', () => {
  // A streaming reply changes the content height by a pixel or two dozens of
  // times a second, and each of those would be an IPC round trip and a
  // compositor reconfigure for a change nobody can see.
  it('answers the same height for a wobble smaller than one step', () => {
    // 193 and 195 want 205 and 207 with the panel's chrome (12px), and both ceil-bucket to
    // 208 — which is between the floor and the cap, so it is the BUCKETING that
    // makes them equal and not a clamp at either end.
    expect(hudWindowHeight(open(193, 0))).toBe(hudWindowHeight(open(195, 0)))
    expect(hudWindowHeight(open(193, 0))).toBe(208)
  })

  it('answers a different height once the wobble crosses a step', () => {
    expect(hudWindowHeight(open(193, 0))).not.toBe(hudWindowHeight(open(197, 0)))
  })

  it('never exceeds the window cap', () => {
    // Bar plus a full panel is well past 520 here, so the cap is what is being
    // asserted rather than the arithmetic happening to land under it.
    expect(hudWindowHeight(open(400, 9999))).toBe(HUD_MAX_HEIGHT_PX)
  })

  it('never grows past the panel cap even when the window has room', () => {
    // 88 + 200 = 288. Under the window cap, so only the PANEL cap
    // can produce this number: without it the answer is the window cap, 520.
    expect(hudWindowHeight(open(88, 9999, 200))).toBe(288)
  })

  it('never shrinks below the bar', () => {
    expect(hudWindowHeight(open(1, 0))).toBe(HUD_BAR_HEIGHT_PX)
    expect(hudWindowHeight(open(-40, 0))).toBe(HUD_BAR_HEIGHT_PX)
  })

  // The collapsed HUD must be bar-height whatever the conversation behind it
  // weighs — otherwise the chevron hides the panel and leaves the window the
  // size of the panel it just hid.
  it('ignores the transcript entirely while the panel is collapsed', () => {
    expect(hudWindowHeight({ bandMaxPx: 336, barPx: 96, contentPx: 9999, open: false })).toBe(96)
    expect(hudWindowHeight({ bandMaxPx: 336, barPx: 96, contentPx: 0, open: false })).toBe(96)
  })

  it('grows with the transcript in between', () => {
    // 96 + (120 + 12) = 228 → 232. The panel is doing the work: with `open`
    // false the same inputs answer 96.
    expect(hudWindowHeight(open(96, 120))).toBe(232)
  })

  it('expands to fit the model dropdown menu and restores when closed', () => {
    // Collapsed bar with model menu open: 88 + 360 = 448
    expect(hudWindowHeight({ bandMaxPx: 336, barPx: 88, contentPx: 0, modelMenuOpen: true, open: false })).toBe(448)
    // When closed, collapses back to bar height
    expect(hudWindowHeight({ bandMaxPx: 336, barPx: 88, contentPx: 0, modelMenuOpen: false, open: false })).toBe(
      HUD_BAR_HEIGHT_PX
    )
  })

  it('expands to fit the attachment dropdown menu and restores when closed', () => {
    // Collapsed bar with attachment menu open: 88 + 360 = 448
    expect(hudWindowHeight({ attachmentMenuOpen: true, bandMaxPx: 336, barPx: 88, contentPx: 0, open: false })).toBe(
      448
    )
    // When closed, collapses back to bar height
    expect(hudWindowHeight({ attachmentMenuOpen: false, bandMaxPx: 336, barPx: 88, contentPx: 0, open: false })).toBe(
      HUD_BAR_HEIGHT_PX
    )
  })

  // A card that has not been laid out reports 0 for every box, and arithmetic
  // over a zero-width element produces NaN one step upstream. A HUD that shrank
  // to nothing on its first frame is an invisible window holding the keyboard.
  it('falls back to the bar for a measurement that is not a number', () => {
    expect(hudWindowHeight(open(Number.NaN, Number.NaN))).toBe(HUD_BAR_HEIGHT_PX)
    expect(hudWindowHeight(open(Number.POSITIVE_INFINITY, 0))).toBe(HUD_BAR_HEIGHT_PX)
  })
})

describe('hudBandMax', () => {
  // The bug this replaces: the cap was half of `window.innerHeight`, and on an
  // ordinary toplevel that IS the HUD's own window — 88px once it opens as a
  // bar. Half of 88 is 44, which is below the panel's own chrome, so the panel
  // could never have opened at all on macOS, Windows or X11.
  it('takes half a short screen rather than a fixed number', () => {
    expect(hudBandMax(600)).toBe(300)
  })

  it('stops at the fixed cap on a tall screen', () => {
    expect(hudBandMax(2160)).toBe(HUD_BAND_MAX_PX)
  })

  // A panel that fits inside the window it lives in. 336 + 88 leaves room under
  // the 520 window cap; if either constant moves so that it does not, the HUD
  // would ask for a window it is never allowed to have and stop growing early.
  it('leaves room for the bar inside the window cap', () => {
    expect(HUD_BAND_MAX_PX + HUD_BAR_HEIGHT_PX).toBeLessThanOrEqual(HUD_MAX_HEIGHT_PX)
  })

  it('answers nothing for a screen it could not measure', () => {
    expect(hudBandMax(Number.NaN)).toBe(0)
    expect(hudBandMax(-100)).toBe(0)
  })
})

describe('hudWindowWidth', () => {
  it('returns HUD_WIDTH_PX (600px) by default', () => {
    expect(hudWindowWidth({})).toBe(600)
    expect(hudWindowWidth({ modelMenuOpen: false, attachmentMenuOpen: false })).toBe(600)
    expect(hudWindowWidth({ modelMenuOpen: true })).toBe(600)
    expect(hudWindowWidth({ attachmentMenuOpen: true })).toBe(600)
  })
})
