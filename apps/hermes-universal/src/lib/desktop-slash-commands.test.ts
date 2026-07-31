import { describe, expect, it } from 'vitest'

import { rankSkillCommands, type SkillCatalogMap } from './desktop-slash-commands'

const rows = [{ text: '/alpha' }, { text: '/beta' }, { text: '/gamma' }]

const skills: SkillCatalogMap = {
  '/alpha': { origin: 'bundled', usage: 0 },
  '/beta': { origin: 'hub', usage: 5 },
  '/gamma': { origin: 'bundled', usage: 2 }
}

describe('rankSkillCommands', () => {
  it('orders by usage, A–Z within a tie', () => {
    const ranked = rankSkillCommands([{ text: '/b' }, { text: '/a' }, { text: '/hot' }], {
      '/a': { usage: 1 },
      '/b': { usage: 1 },
      '/hot': { usage: 9 }
    })

    expect(ranked.map(row => row.text)).toEqual(['/hot', '/a', '/b'])
  })

  it('keeps never-used built-ins while browsing is off', () => {
    expect(rankSkillCommands(rows, skills).map(row => row.text)).toEqual(['/beta', '/gamma', '/alpha'])
  })

  it('drops never-used bundled skills when browsing a bare slash', () => {
    const ranked = rankSkillCommands(rows, skills, { pruneUnusedBuiltins: true })

    expect(ranked.map(row => row.text)).toEqual(['/beta', '/gamma'])
  })

  it('keeps rows the catalog has no entry for, even while pruning', () => {
    const ranked = rankSkillCommands([...rows, { text: '/unknown' }], skills, { pruneUnusedBuiltins: true })

    expect(ranked.map(row => row.text)).toContain('/unknown')
  })

  it('reorders and hides nothing on an older backend with no skills map', () => {
    expect(rankSkillCommands(rows, undefined).map(row => row.text)).toEqual(['/alpha', '/beta', '/gamma'])
  })
})
