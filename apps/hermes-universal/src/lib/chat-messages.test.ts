import { describe, expect, it } from 'vitest'

import {
  appendSealedReasoning,
  appendStreamPart,
  applySettledReasoning,
  type ChatMessage,
  type ChatPart,
  collectUnspokenTurnSpeech,
  userTurnOrdinal
} from './chat-messages'

const assistant = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  parts: text ? [{ type: 'text', text }] : [],
  ...extra
})

const user = (id: string, text: string): ChatMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }]
})

describe('collectUnspokenTurnSpeech', () => {
  it('includes sealed interim narration AND the final answer of a tool-calling turn', () => {
    const messages = [
      user('u1', 'what time is it?'),
      assistant('a1', 'Let me check the clock.', { interim: true }),
      assistant('a2', 'It is 9 PM.')
    ]

    const speech = collectUnspokenTurnSpeech(messages, null)

    expect(speech).not.toBeNull()
    expect(speech?.id).toBe('a1')
    expect(speech?.text).toBe('Let me check the clock.\n\nIt is 9 PM.')
    expect(speech?.pending).toBe(false)
  })

  it('keeps the binding id stable and the text append-only while later bubbles stream', () => {
    const turnStart = [user('u1', 'go'), assistant('a1', 'Let me check.', { interim: true })]
    const first = collectUnspokenTurnSpeech(turnStart, null)

    const turnLater = [...turnStart, assistant('a2', 'Still work', { pending: true })]
    const later = collectUnspokenTurnSpeech(turnLater, null)

    expect(first?.id).toBe('a1')
    expect(later?.id).toBe('a1')
    // The controller feeds the delta as `text.slice(sourceLength)`, so an earlier
    // snapshot MUST be a prefix of a later one or audio is lost/duplicated.
    expect(later?.text.startsWith(first?.text ?? '')).toBe(true)
    expect(later?.pending).toBe(true)
  })

  it('starts after the last spoken message and skips empty bubbles', () => {
    const messages = [
      assistant('a0', 'Spoken last turn.'),
      user('u1', 'next'),
      assistant('a1', '', { pending: false }),
      assistant('a2', 'The real reply.')
    ]

    const speech = collectUnspokenTurnSpeech(messages, 'a0')

    expect(speech?.id).toBe('a2')
    expect(speech?.text).toBe('The real reply.')
  })

  it('reports pending from the newest assistant bubble even when it has no text yet', () => {
    const messages = [assistant('a1', 'Narration done.', { interim: true }), assistant('a2', '', { pending: true })]

    const speech = collectUnspokenTurnSpeech(messages, null)

    expect(speech?.id).toBe('a1')
    expect(speech?.text).toBe('Narration done.')
    expect(speech?.pending).toBe(true)
  })

  it('ignores an unknown cursor id rather than dropping the turn', () => {
    const speech = collectUnspokenTurnSpeech([assistant('a1', 'Only reply.')], 'gone')

    expect(speech?.id).toBe('a1')
  })

  it('returns null when everything is spoken or there is no assistant text', () => {
    expect(collectUnspokenTurnSpeech([], null)).toBeNull()
    expect(collectUnspokenTurnSpeech([assistant('a1', 'Done.')], 'a1')).toBeNull()
    expect(collectUnspokenTurnSpeech([user('u1', 'hello'), assistant('a1', '')], null)).toBeNull()
  })
})

describe('userTurnOrdinal', () => {
  const transcript = [
    user('u1', 'first'),
    assistant('a1', 'one'),
    user('u2', 'second'),
    assistant('a2', 'two'),
    user('u3', 'third')
  ]

  it('counts user turns over the WHOLE transcript, skipping assistant rows', () => {
    expect(userTurnOrdinal(transcript, 'u1')).toBe(0)
    expect(userTurnOrdinal(transcript, 'u2')).toBe(1)
    expect(userTurnOrdinal(transcript, 'u3')).toBe(2)
  })

  // The number the backend truncates by. Counting it over a windowed tail (what
  // the transcript renders) reports 0 for a turn the session calls 2 — see
  // MJXHRM-223.
  it('disagrees with the same count taken over a windowed tail', () => {
    const windowed = transcript.slice(2)

    expect(userTurnOrdinal(windowed, 'u3')).toBe(1)
    expect(userTurnOrdinal(transcript, 'u3')).toBe(2)
  })

  it('answers null for an assistant row or an id it does not hold', () => {
    expect(userTurnOrdinal(transcript, 'a1')).toBeNull()
    expect(userTurnOrdinal(transcript, 'nope')).toBeNull()
  })
})

/**
 * A sealed reasoning part is one CLOSED, attributed thought. It exists because
 * `moa.reference` carries a different model's finished answer, and the
 * aggregator's own reasoning arrives on the same session immediately after it.
 */
describe('sealed reasoning blocks', () => {
  const sealed = (text: string): ChatPart => ({ type: 'reasoning', text, sealed: true })

  it('opens a new block instead of coalescing a reasoning delta into a closed one', () => {
    expect(appendStreamPart([sealed('advisor answer')], 'reasoning', 'aggregator thought')).toEqual([
      sealed('advisor answer'),
      { type: 'reasoning', text: 'aggregator thought' }
    ])
  })

  it('does not scan PAST a closed block into the live one before it', () => {
    const parts: ChatPart[] = [{ type: 'reasoning', text: 'trail\n' }, sealed('advisor answer')]

    expect(appendStreamPart(parts, 'reasoning', 'aggregator thought')).toEqual([
      ...parts,
      { type: 'reasoning', text: 'aggregator thought' }
    ])
  })

  it('still coalesces into an OPEN reasoning block', () => {
    expect(appendStreamPart([{ type: 'reasoning', text: 'half ' }], 'reasoning', 'a thought')).toEqual([
      { type: 'reasoning', text: 'half a thought' }
    ])
  })

  // The seal closes the REASONING channel only. Prose deltas either side of an
  // advisory block are still one sentence and must stay one bubble.
  it('leaves the text channel transparent', () => {
    const parts: ChatPart[] = [{ type: 'text', text: 'the answer ' }, sealed('advisor answer')]

    expect(appendStreamPart(parts, 'text', 'is 42')).toEqual([
      { type: 'text', text: 'the answer is 42' },
      sealed('advisor answer')
    ])
  })

  it('appends settled reasoning after a closed block rather than replacing it', () => {
    expect(applySettledReasoning([sealed('advisor answer')], 'aggregator scratchpad')).toEqual([
      sealed('advisor answer'),
      { type: 'reasoning', text: 'aggregator scratchpad' }
    ])
  })

  it('still replaces an OPEN reasoning block with the authoritative full text', () => {
    expect(applySettledReasoning([{ type: 'reasoning', text: 'partial' }], 'the full thought')).toEqual([
      { type: 'reasoning', text: 'the full thought' }
    ])
  })

  // The dedupe asks "did we already stream this very thought?". Another model's
  // answer that happens to contain the same words is not that thought.
  it('does not let a closed block suppress identical settled reasoning', () => {
    expect(applySettledReasoning([sealed('use the second approach')], 'use the second approach')).toEqual([
      sealed('use the second approach'),
      { type: 'reasoning', text: 'use the second approach' }
    ])
  })

  it('still drops settled reasoning already streamed into an open block', () => {
    const parts: ChatPart[] = [{ type: 'reasoning', text: 'use the second approach, obviously' }]

    expect(applySettledReasoning(parts, 'use the second approach')).toBe(parts)
  })

  describe('appendSealedReasoning', () => {
    it('closes the open block it lands in', () => {
      expect(appendSealedReasoning([{ type: 'reasoning', text: 'trail\n' }], '◇ MoA aggregating…\n')).toEqual([
        sealed('trail\n◇ MoA aggregating…\n')
      ])
    })

    it('opens its own closed block after another closed one', () => {
      expect(appendSealedReasoning([sealed('advisor answer')], '◇ MoA aggregating…\n')).toEqual([
        sealed('advisor answer'),
        sealed('◇ MoA aggregating…\n')
      ])
    })
  })
})
