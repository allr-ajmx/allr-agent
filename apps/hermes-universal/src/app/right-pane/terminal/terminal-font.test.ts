import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $terminalFontFamily,
  applyTerminalFontFamily,
  DEFAULT_TERMINAL_FONT_FAMILY,
  resolveTerminalFontFamily,
  syncTerminalFontFromConfig
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

describe('syncTerminalFontFromConfig', () => {
  it('reads terminal.font_family into the live atom', async () => {
    await syncTerminalFontFromConfig(async () => ({ terminal: { font_family: 'Hack Nerd Font' } }))

    expect($terminalFontFamily.get()).toBe('Hack Nerd Font')
  })

  it('leaves the default standing when config is unreachable', async () => {
    await syncTerminalFontFromConfig(async () => {
      throw new Error('offline')
    })

    expect($terminalFontFamily.get()).toBe('')
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
