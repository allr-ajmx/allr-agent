import { describe, expect, it } from 'vitest'

import { deriveDraftTitle } from '@/lib/draft-title'

describe('deriveDraftTitle', () => {
  it('names a draft after its first meaningful line', () => {
    expect(deriveDraftTitle('  \n\nfix the login redirect\nand then some')).toBe('fix the login redirect')
  })

  it('collapses runs of whitespace', () => {
    expect(deriveDraftTitle('fix   the    redirect')).toBe('fix the redirect')
  })

  it('titles from the argument, not the command name', () => {
    // A bare `/skin` names the draft after the command rather than the work.
    expect(deriveDraftTitle('/goal ship the release')).toBe('ship the release')
    expect(deriveDraftTitle('/compress')).toBe('')
  })

  it('is empty when there is nothing worth naming, so the placeholder stands', () => {
    expect(deriveDraftTitle('')).toBe('')
    expect(deriveDraftTitle('   \n\t\n ')).toBe('')
  })

  it('cuts on a word boundary and ellipsizes', () => {
    const title = deriveDraftTitle('the quick brown fox jumps over the lazy dog and keeps on running')

    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(49)
    expect(title).toBe('the quick brown fox jumps over the lazy dog and…')
  })

  it('hard-cuts a single word too long to break', () => {
    const title = deriveDraftTitle('a'.repeat(80))

    // No space past the halfway mark, so the word is cut rather than dropped.
    expect(title).toBe(`${'a'.repeat(48)}…`)
  })
})
