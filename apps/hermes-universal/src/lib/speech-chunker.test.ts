import { describe, expect, it } from 'vitest'

import { takeSpeechChunk } from './speech-chunker'

describe('takeSpeechChunk', () => {
  it('takes a leading sentence once it is long enough', () => {
    expect(takeSpeechChunk('Hi there. More coming')).toEqual({
      chunk: 'Hi there.',
      rest: 'More coming'
    })
  })

  it('holds a too-short leading sentence until forced', () => {
    // "Hi." is under the 8-char minimum → nothing yet.
    expect(takeSpeechChunk('Hi. and then')).toEqual({ chunk: null, rest: 'Hi. and then' })
    // Forcing flushes the whole buffer.
    expect(takeSpeechChunk('Hi. and then', true)).toEqual({ chunk: 'Hi.', rest: 'and then' })
  })

  it('matches CJK sentence punctuation (needs a trailing boundary, like the original)', () => {
    // The sentence regex requires whitespace-or-end after the terminal — so with a
    // space it chunks, and without one it waits (verbatim from the ported logic).
    expect(takeSpeechChunk('こんにちは、世界。 次の文')).toEqual({
      chunk: 'こんにちは、世界。',
      rest: '次の文'
    })
    expect(takeSpeechChunk('こんにちは、世界。次の文')).toEqual({
      chunk: null,
      rest: 'こんにちは、世界。次の文'
    })
  })

  it('splits a long boundary-less buffer at a soft boundary', () => {
    const long = `${'a'.repeat(120)}, ${'b'.repeat(120)}`
    const { chunk, rest } = takeSpeechChunk(long)
    // Soft boundary is the last ", " before index 180 (well past index 80).
    expect(chunk?.endsWith(',')).toBe(true)
    expect(chunk?.startsWith('a')).toBe(true)
    expect(rest.startsWith('b')).toBe(true)
  })

  it('takes nothing from a short boundary-less buffer without force', () => {
    expect(takeSpeechChunk('just some words with no end')).toEqual({
      chunk: null,
      rest: 'just some words with no end'
    })
  })

  it('flushes the whole buffer when forced', () => {
    expect(takeSpeechChunk('no terminal punctuation here', true)).toEqual({
      chunk: 'no terminal punctuation here',
      rest: ''
    })
  })

  it('collapses whitespace and trims', () => {
    expect(takeSpeechChunk('  Hello   world.  next ')).toEqual({
      chunk: 'Hello world.',
      rest: 'next'
    })
  })

  it('returns empty for a blank buffer', () => {
    expect(takeSpeechChunk('   ')).toEqual({ chunk: null, rest: '' })
  })

  // A blank line is how `collectUnspokenTurnSpeech` joins a turn's sealed
  // bubbles. Everything before it is finished, so it must flush immediately —
  // and the remaining boundaries must survive into `rest`.
  describe('sealed paragraph boundary', () => {
    it('flushes a sealed bubble with no terminal punctuation', () => {
      expect(takeSpeechChunk('Let me check the clock\n\nIt is 9 PM.')).toEqual({
        chunk: 'Let me check the clock',
        rest: 'It is 9 PM.'
      })
    })

    it('keeps later boundaries intact across successive takes', () => {
      const first = takeSpeechChunk('A one\n\nB two\n\nC three')

      expect(first).toEqual({ chunk: 'A one', rest: 'B two\n\nC three' })
      expect(takeSpeechChunk(first.rest)).toEqual({ chunk: 'B two', rest: 'C three' })
    })

    it('still chunks a multi-sentence sealed bubble sentence by sentence', () => {
      expect(takeSpeechChunk('One. Two.\n\nTail')).toEqual({ chunk: 'One.', rest: 'Two.\n\nTail' })
    })

    it('does not run two bubbles together into one utterance', () => {
      // Without the boundary rule the whitespace collapse made this
      // "Let me check It is 9 PM." — one run-on sentence.
      expect(takeSpeechChunk('Let me check\n\nIt is 9 PM.').chunk).toBe('Let me check')
    })

    it('ignores a single newline (ordinary wrapped prose)', () => {
      expect(takeSpeechChunk('wrapped\nline with no end')).toEqual({
        chunk: null,
        rest: 'wrapped line with no end'
      })
    })
  })
})
