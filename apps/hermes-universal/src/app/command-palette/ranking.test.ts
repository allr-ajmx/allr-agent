import { describe, expect, it } from 'vitest'

import { Zap } from '@/lib/icons'

import { type PaletteGroup, type PaletteItem, paletteValue, rankGroups, scoreItem } from './ranking'

const item = (label: string, keywords?: string[]): PaletteItem => ({
  icon: Zap,
  id: label.toLowerCase().replace(/\s+/g, '-'),
  keywords,
  label
})

describe('scoreItem', () => {
  it('grades an exact label match highest', () => {
    expect(scoreItem(item('Tools'), 'tools')).toBe(1)
  })

  it('grades a label prefix above a mid-label word', () => {
    expect(scoreItem(item('Toolsets'), 'tool')).toBe(0.9)
    expect(scoreItem(item('Manage tools'), 'tools')).toBe(0.85)
  })

  it('grades a word prefix above a bare substring', () => {
    expect(scoreItem(item('Manage toolsets'), 'tool')).toBe(0.8)
    expect(scoreItem(item('Retooling'), 'tool')).toBe(0.7)
  })

  it('grades scattered terms below any single-span match', () => {
    // Both words are in the label, but not adjacent.
    expect(scoreItem(item('Change color mode'), 'change mode')).toBe(0.6)
  })

  it('grades a keyword-only match lowest', () => {
    expect(scoreItem(item('Capabilities', ['tools']), 'tools')).toBe(0.4)
  })

  it('requires every typed term to appear somewhere (AND semantics)', () => {
    expect(scoreItem(item('Change theme', ['appearance']), 'theme appearance')).toBeGreaterThan(0)
    expect(scoreItem(item('Change theme', ['appearance']), 'theme pizza')).toBe(0)
  })

  it('puts a row labelled Tools above one that only keywords it', () => {
    // The regression the ranking exists for: an auto-highlight landing on a
    // generic row while the row that literally says "Tools" sits below it.
    expect(scoreItem(item('Tools'), 'tools')).toBeGreaterThan(scoreItem(item('Capabilities', ['tools']), 'tools'))
  })
})

describe('rankGroups', () => {
  const groups: PaletteGroup[] = [
    { heading: 'Go to', items: [item('Capabilities', ['tools']), item('Settings')] },
    { heading: 'Commands', items: [item('Tools'), item('Restart gateway')] }
  ]

  it('returns the groups untouched for an empty search', () => {
    expect(rankGroups(groups, '   ')).toBe(groups)
  })

  it('orders groups by their best-scoring item', () => {
    const ranked = rankGroups(groups, 'tools')

    expect(ranked.map(group => group.heading)).toEqual(['Commands', 'Go to'])
    expect(ranked[0].items.map(row => row.label)).toEqual(['Tools'])
  })

  it('drops groups whose items all score zero', () => {
    expect(rankGroups(groups, 'gateway').map(group => group.heading)).toEqual(['Commands'])
  })

  it('leaves ties in source order', () => {
    const ties: PaletteGroup[] = [{ heading: 'Themes', items: [item('Nous dark'), item('Nous light')] }]

    expect(rankGroups(ties, 'nous')[0].items.map(row => row.label)).toEqual(['Nous dark', 'Nous light'])
  })
})

describe('paletteValue', () => {
  it('distinguishes two rows that share a label', () => {
    // The same theme lists under both Light and Dark; cmdk needs unique values.
    const light: PaletteItem = { icon: Zap, id: 'theme-nous-light', label: 'Nous' }
    const dark: PaletteItem = { icon: Zap, id: 'theme-nous-dark', label: 'Nous' }

    expect(paletteValue(light)).not.toBe(paletteValue(dark))
  })
})
