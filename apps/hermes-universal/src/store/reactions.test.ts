import { describe, expect, it } from 'vitest'

import { applyReaction } from './reactions'

const user = (emoji: string) => ({ at: 0, author: 'user' as const, emoji })
const agent = (emoji: string) => ({ at: 0, author: 'agent' as const, emoji })

describe('applyReaction', () => {
  it('adds the author a reaction where they had none', () => {
    expect(applyReaction(undefined, '❤️', 'user')).toEqual([expect.objectContaining({ author: 'user', emoji: '❤️' })])
  })

  it('replaces rather than stacks — one reaction per author', () => {
    const next = applyReaction([user('❤️')], '👍', 'user')

    expect(next).toHaveLength(1)
    expect(next[0].emoji).toBe('👍')
  })

  // The tapback rule that makes the affordance feel like a toggle rather than
  // an append-only log: tapping what you already picked takes it back.
  it('retracts when the same emoji is re-sent', () => {
    expect(applyReaction([user('❤️')], '❤️', 'user')).toEqual([])
  })

  it('clears unconditionally on null', () => {
    expect(applyReaction([user('👍')], null, 'user')).toEqual([])
  })

  // The two authors hold separate slots; the agent reacting must not evict the
  // user's own tapback (or the reverse).
  it('leaves the other author alone', () => {
    const next = applyReaction([user('❤️'), agent('😂')], '👍', 'user')

    expect(next.find(reaction => reaction.author === 'agent')?.emoji).toBe('😂')
    expect(next.find(reaction => reaction.author === 'user')?.emoji).toBe('👍')
  })
})
