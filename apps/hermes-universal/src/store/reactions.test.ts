import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { $agentReactions, clearReactionOverlays, mergeReactions } from '@/store/reactions-local'
import { $sessionStates, ensureSessionSlice, updateSession } from '@/store/session-state-types'

import { applyReaction, applyReactionEvent } from './reactions'

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

describe('mergeReactions', () => {
  it('prefers the local overlay for the user slot', () => {
    expect(mergeReactions([user('❤️')], [user('👍')])).toEqual([user('👍')])
  })

  // The two overlays are read independently, so the user clicking something
  // must not hide a reaction the agent left on the same message.
  it('keeps the agent slot when only the user slot is overlaid', () => {
    const merged = mergeReactions([user('❤️'), agent('😂')], [user('👍')])

    expect(merged.map(reaction => reaction.emoji)).toEqual(['👍', '😂'])
  })

  // A mid-turn agent reaction reaches the DB before the in-memory history the
  // next resume projects from, so the live overlay has to win over persisted.
  it('prefers the live overlay for the agent slot', () => {
    expect(mergeReactions([agent('😂')], undefined, [agent('👍')])).toEqual([agent('👍')])
  })

  it('returns a stable empty identity when there is nothing to show', () => {
    expect(mergeReactions(undefined, undefined)).toBe(mergeReactions([], []))
  })
})

describe('applyReactionEvent', () => {
  const seed = (messages: ChatMessage[]) => {
    $sessionStates.set({})
    clearReactionOverlays()
    ensureSessionSlice('s1')
    updateSession('s1', state => ({ ...state, messages }))
  }

  const messagesOf = (key = 's1') => $sessionStates.get()[key]!.messages

  it('stamps a row that already knows its durable id', () => {
    seed([
      { id: 'a', parts: [], role: 'user', rowId: 10 },
      { id: 'b', parts: [], role: 'user', rowId: 11 }
    ])

    applyReactionEvent('s1', 10, 'user', [agent('❤️')])

    expect(messagesOf()[0].reactions).toEqual([agent('❤️')])
    expect(messagesOf()[1].reactions).toBeUndefined()
  })

  // The live leg. A message the user is looking at right now has no row id —
  // it has not round-tripped — so an id-only match would find nothing on
  // exactly the messages most likely to be reacted to.
  it('stamps the newest un-round-tripped row of the target role', () => {
    seed([
      { id: 'a', parts: [], role: 'user' },
      { id: 'b', parts: [], role: 'assistant' },
      { id: 'c', parts: [], role: 'user' }
    ])

    applyReactionEvent('s1', 42, 'user', [agent('👍')])

    expect(messagesOf()[2]).toMatchObject({ id: 'c', rowId: 42 })
    expect(messagesOf()[0].rowId).toBeUndefined()
  })

  // The trap this whole design exists to avoid: a row that already carries a
  // DIFFERENT durable id is a different persisted message, and painting a
  // reaction onto it would be worse than not painting one at all.
  it('never steals a row that already belongs to another message', () => {
    seed([
      { id: 'a', parts: [], role: 'user', rowId: 7 },
      { id: 'b', parts: [], role: 'assistant', rowId: 8 }
    ])

    applyReactionEvent('s1', 99, 'user', [agent('👍')])

    expect(messagesOf().every(message => message.reactions === undefined)).toBe(true)
  })

  it('respects the role the event named', () => {
    seed([
      { id: 'a', parts: [], role: 'user' },
      { id: 'b', parts: [], role: 'assistant' }
    ])

    applyReactionEvent('s1', 5, 'assistant', [agent('😂')])

    expect(messagesOf()[1]).toMatchObject({ id: 'b', rowId: 5 })
    expect(messagesOf()[0].rowId).toBeUndefined()
  })

  // Keyed by DURABLE row id, so it outlives the resume that regenerates every
  // renderer id in the transcript.
  it('records the overlay under the row id', () => {
    seed([{ id: 'a', parts: [], role: 'user' }])

    applyReactionEvent('s1', 77, 'user', [agent('❤️'), user('👍')])

    expect($agentReactions.get()[77]).toEqual([agent('❤️')])
  })

  it('writes a new message object so assistant-ui cannot render a stale copy', () => {
    seed([{ id: 'a', parts: [], role: 'user', rowId: 3 }])

    const before = messagesOf()[0]
    applyReactionEvent('s1', 3, 'user', [agent('❤️')])

    expect(messagesOf()[0]).not.toBe(before)
  })
})
