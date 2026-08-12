import { describe, expect, it } from 'vitest'

import { sanitizeTextForSpeech } from './speech-text'

describe('sanitizeTextForSpeech', () => {
  it('summarizes fenced code blocks instead of reading them literally', () => {
    expect(sanitizeTextForSpeech('Here is code:\n```ts\nconst x = 1\n```\nDone.')).toBe(
      'Here is code: code block omitted Done.'
    )
  })

  it('still keeps normal prose and inline code readable', () => {
    expect(sanitizeTextForSpeech('Use `git status` after the change.')).toBe('Use git status after the change.')
  })

  it('skips markdown table data while preserving surrounding human text', () => {
    const text = `Here is the quick takeaway: the totals remain unchanged.

| Item | Value | Notes |
| --- | ---: | --- |
| Example A | 10 | first row |
| Example B | 20 | second row |

Full detail stays visible on screen.`

    expect(sanitizeTextForSpeech(text)).toBe(
      'Here is the quick takeaway: the totals remain unchanged. Full detail stays visible on screen.'
    )
  })

  it('does not strip prose that merely contains a pipe character', () => {
    const text = 'Use the summary first | keep the table on screen when it matters.'

    expect(sanitizeTextForSpeech(text)).toBe('Use the summary first | keep the table on screen when it matters.')
  })

  it('does not duplicate punctuation across paragraph breaks', () => {
    const text = `First sentence.

Second sentence.`

    expect(sanitizeTextForSpeech(text)).toBe('First sentence. Second sentence.')
  })

  it.each([
    ['markdown emphasis', '**First sentence.**\n\nSecond sentence.', 'First sentence. Second sentence.'],
    ['a closing quote', '“First sentence.”\n\nSecond sentence.', '“First sentence.” Second sentence.'],
    ['a closing parenthesis', '(First sentence.)\n\nSecond sentence.', '(First sentence.) Second sentence.']
  ])('does not duplicate punctuation after %s', (_label, text, expected) => {
    expect(sanitizeTextForSpeech(text)).toBe(expected)
  })

  it('skips markdown tables without leading and trailing pipes', () => {
    const text = `Main takeaway: total is unchanged.

Item | Value
--- | ---:
Example A | 10
Example B | 20

Done.`

    expect(sanitizeTextForSpeech(text)).toBe('Main takeaway: total is unchanged. Done.')
  })

  it('skips markdown tables nested inside blockquotes', () => {
    const text = `Before the table.

> | Item | Value |
> | --- | ---: |
> | Example A | 10 |
> | Example B | 20 |

After the table.`

    expect(sanitizeTextForSpeech(text)).toBe('Before the table. After the table.')
  })

  it('allows marker padding plus three spaces in blockquoted tables', () => {
    const text = `Before the table.

>    | Item | Value |
>    | --- | ---: |
>    | Example A | 10 |

After the table.`

    expect(sanitizeTextForSpeech(text)).toBe('Before the table. After the table.')
  })

  it('skips explicit single-column markdown tables', () => {
    const text = `Before the table.

| Item |
| --- |
| Example A |

After the table.`

    expect(sanitizeTextForSpeech(text)).toBe('Before the table. After the table.')
  })

  it('preserves rows outside a table blockquote', () => {
    const text = `> | Item | Value |
> | --- | ---: |
> | Example A | 10 |
Outside | prose`

    expect(sanitizeTextForSpeech(text)).toBe('Outside | prose')
  })

  it('preserves malformed tables with mismatched column counts', () => {
    const text = `Heading | Detail
--- | --- | ---
Keep this prose.`

    expect(sanitizeTextForSpeech(text)).toContain('Heading | Detail')
  })

  it('skips GFM body rows whose cell counts differ from the header', () => {
    const text = `Before the table.

| Item | Value |
| --- | ---: |
| Example A |
| Example B | 20 | ignored |

After the table.`

    expect(sanitizeTextForSpeech(text)).toBe('Before the table. After the table.')
  })

  it('skips tables containing escaped pipe characters', () => {
    const text = `Before the table.

| Item \\| detail | Value |
| --- | ---: |
| Example A | 10 |

After the table.`

    expect(sanitizeTextForSpeech(text)).toBe('Before the table. After the table.')
  })

  // The line-anchored rules. These ran AFTER the line breaks had been flattened,
  // so `^` under /m only ever matched offset 0: the first list item lost its
  // marker and every later one kept it (MJXHRM-369).
  describe('line-anchored markers', () => {
    it('strips the marker from every bullet, not just the first', () => {
      expect(sanitizeTextForSpeech('Steps:\n- first item\n- second item\n- third item')).toBe(
        'Steps: first item second item third item'
      )
    })

    it('strips ordered-list markers', () => {
      // Also keeps "1." out of the chunker's sentence detector, which read it as
      // a complete sentence and cut the list into one-word clips.
      expect(sanitizeTextForSpeech('Steps:\n1. first item\n2. second item')).toBe('Steps: first item second item')
    })

    // Honest label: this one does NOT discriminate the ordering fix, because the
    // catch-all `[*_~>#]` strip removes a stray hash however late it runs. It is
    // here as a guard on the outcome, so removing that catch-all can't quietly
    // start voicing "hash hash".
    it('does not voice a heading marker on any line', () => {
      expect(sanitizeTextForSpeech('Intro line\n## Second heading\nBody')).toBe('Intro line Second heading Body')
    })

    it('drops a thematic break instead of voicing three dashes', () => {
      expect(sanitizeTextForSpeech('Before.\n\n---\n\nAfter.')).toBe('Before. After.')
    })

    it('leaves a mid-line hyphen alone (the marker rules are line-anchored)', () => {
      expect(sanitizeTextForSpeech('A well-known 2 - 3 range.')).toBe('A well-known 2 - 3 range.')
    })
  })

  it('preserves indented code that resembles a table', () => {
    const text = `    Item | Value
    --- | ---
    Example A | 10`

    expect(sanitizeTextForSpeech(text)).toContain('Item | Value')
  })
})
