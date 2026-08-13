import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveSurfaceColor, terminalTheme, withSurface } from './terminal-theme'

// This pins the "always a full, readable table" contract that the fix depends on.
describe('terminalTheme', () => {
  it('returns the complete dark default table when no skin palette is given', () => {
    const theme = terminalTheme('dark')
    expect(theme.foreground).toBe('#cccccc')
    expect(theme.green).toBe('#0dbc79')
    expect(theme.brightWhite).toBe('#e5e5e5')
    expect(theme.selectionBackground).toBe('#264f7866')
  })

  it('returns the complete light default table when no skin palette is given', () => {
    const theme = terminalTheme('light')
    expect(theme.foreground).toBe('#333333')
    expect(theme.yellow).toBe('#949800') // mustard, legible on white
    expect(theme.selectionBackground).toBe('#add6ff80')
  })

  it('overlays only truthy palette slots, keeping the mode default for the rest', () => {
    const theme = terminalTheme('dark', { red: '#ff0000', green: undefined })
    expect(theme.red).toBe('#ff0000') // overridden
    expect(theme.green).toBe('#0dbc79') // undefined slot → keeps default
    expect(theme.foreground).toBe('#cccccc') // untouched default
  })
})

// The two DOM-touching halves were left to "the tauri-dev visual check", which
// is why "the terminal is painted white" survived as a claim nobody could settle
// (MJXHRM-378). White is a REAL value in here — it is LIGHT_THEME.background, the
// fallback resolveSurfaceColor returns when the skin surface does not resolve —
// so the thing worth pinning is exactly WHEN it can be reached.
describe('surface binding', () => {
  afterEach(() => vi.restoreAllMocks())

  it('probes the same custom property the terminal panes paint, and leaves no node behind', () => {
    const appended: Node[] = []
    const realAppend = document.body.appendChild.bind(document.body)
    vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      appended.push(node)

      return realAppend(node)
    })

    const before = document.body.childElementCount
    resolveSurfaceColor('#1e1e1e')

    // The canvas colour and the CSS around it MUST name one token, or the xterm
    // background and the padding/viewport it sits in drift apart on a re-skin —
    // which is the seam that reads as "the terminal is painted white".
    expect((appended[0] as HTMLElement).getAttribute('style')).toContain('var(--ui-editor-surface-background)')
    expect(document.body.childElementCount).toBe(before)
  })

  it('binds background and the block-cursor glyph to the resolved surface, leaving the table alone', () => {
    // Deliberately contradicts the seed: the LIGHT table defaults to a white
    // background, and the live surface is near-black. The surface has to win.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ backgroundColor: 'rgb(13, 13, 14)' } as CSSStyleDeclaration)

    const theme = withSurface(terminalTheme('light'))

    expect(theme.background).toBe('rgb(13, 13, 14)')
    expect(theme.cursorAccent).toBe('rgb(13, 13, 14)')
    expect(theme.foreground).toBe('#333333')
    expect(theme.yellow).toBe('#949800')
  })

  it('falls back to the mode table only when the surface does not resolve', () => {
    // An undefined/invalid custom property computes background-color to its
    // initial value — transparent. That, and nothing else, is the route to a
    // white terminal, and only on a LIGHT painted mode.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ backgroundColor: 'rgba(0, 0, 0, 0)' } as CSSStyleDeclaration)

    expect(resolveSurfaceColor('#1e1e1e')).toBe('#1e1e1e')
    expect(withSurface(terminalTheme('light')).background).toBe('#ffffff')
    expect(withSurface(terminalTheme('dark')).background).toBe('#1e1e1e')
  })
})
