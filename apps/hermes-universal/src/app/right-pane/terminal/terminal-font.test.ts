import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $terminalFontFamily,
  applyTerminalFontFamily,
  DEFAULT_TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  terminalFontFamilyFromConfig
} from './terminal-font'

beforeEach(() => {
  $terminalFontFamily.set('')
})

describe('resolveTerminalFontFamily', () => {
  it('falls back to the bundled stack when unset', () => {
    expect(resolveTerminalFontFamily('')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    expect(resolveTerminalFontFamily(undefined)).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
    expect(resolveTerminalFontFamily('   ')).toBe(DEFAULT_TERMINAL_FONT_FAMILY)
  })

  it('quotes a friendly single family and keeps the default as the tail', () => {
    expect(resolveTerminalFontFamily('MesloLGS NF')).toBe(`'MesloLGS NF', ${DEFAULT_TERMINAL_FONT_FAMILY}`)
  })

  it('passes an authored stack through unquoted', () => {
    expect(resolveTerminalFontFamily('Iosevka, monospace')).toBe(`Iosevka, monospace, ${DEFAULT_TERMINAL_FONT_FAMILY}`)
    expect(resolveTerminalFontFamily("'Fira Code'")).toBe(`'Fira Code', ${DEFAULT_TERMINAL_FONT_FAMILY}`)
  })

  // Desktop parity, and deliberate: any quote in the value means "the user
  // authored a stack", so it is passed through verbatim rather than re-quoted.
  // A bare family name containing an apostrophe is therefore emitted unquoted —
  // documented here so a future reader knows it is the heuristic's cost, not an
  // oversight in the escaper below it.
  it('treats anything already containing a quote as an authored stack', () => {
    expect(resolveTerminalFontFamily("Odd'Name")).toBe(`Odd'Name, ${DEFAULT_TERMINAL_FONT_FAMILY}`)
  })
})

describe('terminalFontFamilyFromConfig', () => {
  it('reads terminal.font_family off a config record', () => {
    expect(terminalFontFamilyFromConfig({ terminal: { font_family: '  Hack Nerd Font  ' } })).toBe('Hack Nerd Font')
  })

  it('reads empty from a record that never set the key', () => {
    expect(terminalFontFamilyFromConfig({ terminal: {} })).toBe('')
    expect(terminalFontFamilyFromConfig({})).toBe('')
  })

  // config.yaml is hand-authored YAML, so the value is whatever the user typed:
  // `font_family: 12` parses as a number and `font_family: [a]` as a list. Both
  // arrive here as-is, and calling .trim() on either throws inside the render of
  // the picker AND of the terminal pane — a bad key has to degrade, not explode.
  it('reads empty from a value that is not a string at all', () => {
    expect(terminalFontFamilyFromConfig({ terminal: { font_family: 12 } })).toBe('')
    expect(terminalFontFamilyFromConfig({ terminal: { font_family: ['MesloLGS NF'] } })).toBe('')
    expect(terminalFontFamilyFromConfig({ terminal: { font_family: { name: 'MesloLGS NF' } } })).toBe('')
  })

  it('reads empty rather than throwing when the config never arrived', () => {
    expect(terminalFontFamilyFromConfig(undefined)).toBe('')
    expect(terminalFontFamilyFromConfig(null)).toBe('')
    expect(terminalFontFamilyFromConfig({ terminal: 'not-an-object' })).toBe('')
  })
})

describe('applyTerminalFontFamily', () => {
  const target = () => ({
    options: {} as { fontFamily?: string },
    refresh: vi.fn<(start: number, end: number) => void>(),
    rows: 24
  })

  it('warms, sets, re-fits, then drops the atlas — in that order', async () => {
    const term = target()
    const order: string[] = []

    await applyTerminalFontFamily({
      clearTextureAtlas: () => order.push('atlas'),
      fit: () => order.push('fit'),
      fontFamily: 'Iosevka',
      isCurrent: () => true,
      term,
      warm: async () => void order.push('warm')
    })

    expect(term.options.fontFamily).toBe('Iosevka')
    // Clearing before the fit would rebuild the atlas at the OLD grid size.
    expect(order).toEqual(['warm', 'fit', 'atlas'])
    expect(term.refresh).toHaveBeenCalledWith(0, 23)
  })

  it('abandons a change superseded while the face was loading', async () => {
    const term = target()

    const applied = await applyTerminalFontFamily({
      clearTextureAtlas: vi.fn(),
      fit: vi.fn(),
      fontFamily: 'Iosevka',
      isCurrent: () => false,
      term,
      warm: async () => undefined
    })

    expect(applied).toBe(false)
    expect(term.options.fontFamily).toBeUndefined()
  })
})
