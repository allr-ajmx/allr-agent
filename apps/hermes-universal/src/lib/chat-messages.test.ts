import { describe, expect, it } from 'vitest'

import { type ChatMessage, collectUnspokenTurnSpeech, userTurnOrdinal } from './chat-messages'

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
