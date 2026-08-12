import { describe, expect, it } from 'vitest'

import { takeSpeechChunk } from './speech-chunker'
import { sanitizeTextForSpeech } from './speech-text'

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

  it('collapses runs of spaces and trims the chunk', () => {
    expect(takeSpeechChunk('  Hello   world.  next ')).toEqual({
      chunk: 'Hello world.',
      rest: 'next '
    })
  })

  // `rest` keeps its trailing space on purpose: the caller appends the next
  // streaming delta straight onto it, and trimming ran the last word of one
  // delta into the first word of the next ("2. second" → "2.second").
  it('does not run two deltas together when the delta boundary lands after a space', () => {
    const afterFirstDelta = takeSpeechChunk('Ready to go. Item one ')

    expect(afterFirstDelta.chunk).toBe('Ready to go.')
    expect(takeSpeechChunk(`${afterFirstDelta.rest}and item two.`, true).chunk).toBe('Item one and item two.')
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

    // A single newline is not a boundary — but it is NOT flattened either. The
    // sanitizer's table, list, heading and thematic-break rules are all anchored
    // to a line start, so a chunk handed over as one long line is one it cannot
    // clean (MJXHRM-369). It collapses the breaks itself at the very end.
    it('keeps a single newline rather than flattening the buffer', () => {
      expect(takeSpeechChunk('wrapped\nline with no end')).toEqual({
        chunk: null,
        rest: 'wrapped\nline with no end'
      })
    })

    it('does not take a "sentence" across a line break', () => {
      // Flattened first, "Steps:\n1. Do it." offered "Steps: 1." as a sentence.
      expect(takeSpeechChunk('Steps:\n1. Do the thing. Then stop.')).toEqual({
        chunk: null,
        rest: 'Steps:\n1. Do the thing. Then stop.'
      })
    })
  })

  // Every rule below exists so `sanitizeTextForSpeech` receives whole markdown
  // blocks. Split one and the sanitizer summarises only the half that still
  // carries its markers, and the other half is voiced as source (MJXHRM-369).
  describe('markdown blocks are never cut in half', () => {
    it('offers nothing from inside an unterminated fence', () => {
      const { chunk, rest } = takeSpeechChunk('Try this out.\n```ts\nconst secret = 1\n')

      expect(chunk).toBe('Try this out.')
      expect(takeSpeechChunk(rest)).toEqual({ chunk: null, rest: '```ts\nconst secret = 1\n' })
    })

    it('does not seal on a blank line inside a fence', () => {
      const buffer = 'Try this.\n\n```py\ndef f():\n\n    return SECRET\n```\n\nDone.'
      const first = takeSpeechChunk(buffer)

      expect(first.chunk).toBe('Try this.')

      const second = takeSpeechChunk(first.rest)

      // The whole fence, in one piece — not "```py\ndef f():" with the body left
      // behind to be read out as code.
      expect(second.chunk).toBe('```py\ndef f():\n\nreturn SECRET\n```')
      expect(second.rest).toBe('Done.')
    })

    it('releases a fence once it closes', () => {
      expect(takeSpeechChunk('```ts\nconst x = 1\n```\n\nDone.')).toEqual({
        chunk: '```ts\nconst x = 1\n```',
        rest: 'Done.'
      })
    })

    it('flushes an unterminated fence when the turn ends', () => {
      expect(takeSpeechChunk('```ts\nconst x = 1', true)).toEqual({
        chunk: '```ts\nconst x = 1',
        rest: ''
      })
    })

    it('does not soft-split a long multi-line block at one of its commas', () => {
      const table = `| Item | Value |\n| --- | --- |\n${Array.from(
        { length: 8 },
        (_, index) => `| Example ${index}, long | ${index}0 |`
      ).join('\n')}`

      expect(table.length).toBeGreaterThan(220)
      expect(takeSpeechChunk(table)).toEqual({ chunk: null, rest: table })
    })

    it('still soft-splits a long single-line paragraph', () => {
      const long = `${'a'.repeat(120)}, ${'b'.repeat(120)}`

      expect(takeSpeechChunk(long).chunk?.endsWith(',')).toBe(true)
    })
  })
})

/**
 * End to end over the pair, because neither half is correct alone: the
 * voice-conversation loop chunks a STREAMING reply and sanitizes each chunk at
 * the playback seam, so what the engine actually receives is
 * `sanitizeTextForSpeech(takeSpeechChunk(...))` applied repeatedly to a growing
 * buffer — never to the whole reply. Asserting on the sanitizer alone (which is
 * what `speech-text.test.ts` does) proves nothing about that path.
 */
function speakStreamed(reply: string, deltaSize = 24): string {
  const spoken: string[] = []
  let buffer = ''

  const drain = (force: boolean) => {
    for (;;) {
      const { chunk, rest } = takeSpeechChunk(buffer, force)
      buffer = rest

      if (!chunk) {
        return
      }

      const speakable = sanitizeTextForSpeech(chunk)

      if (speakable) {
        spoken.push(speakable)
      }
    }
  }

  for (let index = 0; index < reply.length; index += deltaSize) {
    buffer += reply.slice(index, index + deltaSize)
    drain(false)
  }

  drain(true)

  return spoken.join(' ')
}

describe('what a streamed reply is actually spoken as', () => {
  it('summarizes a fenced block instead of reading the code after it', () => {
    const spoken = speakStreamed('Try this:\n\n```py\ndef f():\n\n    return SECRET\n```\n\nDone.')

    expect(spoken).not.toContain('SECRET')
    expect(spoken).toBe('Try this: code block omitted Done.')
  })

  it('summarizes a code block too long to arrive in one delta', () => {
    const code = Array.from({ length: 12 }, (_, index) => `  const value${index} = compute(index, ${index})`).join('\n')
    const spoken = speakStreamed(`Try this:\n\n\`\`\`js\n${code}\n\`\`\`\n\nDone.`)

    expect(spoken).not.toContain('compute')
    expect(spoken).toBe('Try this: code block omitted Done.')
  })

  it('skips a markdown table instead of reading its pipes and cells', () => {
    const spoken = speakStreamed('Before.\n\n| Item | Value |\n| --- | --- |\n| A | 10 |\n| B | 20 |\n\nAfter.')

    expect(spoken).not.toContain('|')
    expect(spoken).toBe('Before. After.')
  })

  it('drops list markers from every item of a streamed list', () => {
    expect(speakStreamed('Steps:\n\n- first item\n- second item\n- third item\n\nDone.')).toBe(
      'Steps: first item second item third item Done.'
    )
  })

  it('does not voice an ordered list as one clip per number', () => {
    expect(speakStreamed('Steps:\n\n1. first item\n2. second item\n\nDone.')).toBe(
      'Steps: first item second item Done.'
    )
  })

  it('leaves plain prose exactly as before', () => {
    expect(speakStreamed('Hello there. This is a plain reply.\n\nAnd a second paragraph.')).toBe(
      'Hello there. This is a plain reply. And a second paragraph.'
    )
  })
})
