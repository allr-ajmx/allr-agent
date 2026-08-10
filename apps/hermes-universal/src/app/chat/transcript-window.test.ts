import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { RENDER_WEIGHT_CHARS } from '@/lib/render-weight'

import { selectTranscriptWindow, TRANSCRIPT_WINDOW_BUDGET, TRANSCRIPT_WINDOW_MIN_MESSAGES } from './transcript-window'

const message = (id: string, chars: number): ChatMessage => ({
  id,
  parts: [{ type: 'text', text: 'x'.repeat(chars) }],
  role: id.startsWith('u') ? 'user' : 'assistant'
})

/** Messages of `chars` each, newest last. */
const transcript = (count: number, chars: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => message(`m-${i}`, chars))

describe('selectTranscriptWindow', () => {
  it('does not window a transcript that fits the budget', () => {
    const messages = transcript(50, 100)

    const window = selectTranscriptWindow(messages)

    expect(window.windowed).toBe(false)
    // Reference identity preserved — a fresh array would re-render the runtime.
    expect(window.messages).toBe(messages)
  })

  it('windows a HEAVY-but-SHORT transcript that a message-count cap would miss', () => {
    // 40 messages, each a big tool result. Well under any sane count cap, but
    // this is the shape that exhausts the renderer heap (#55191).
    const messages = transcript(40, RENDER_WEIGHT_CHARS * 400)

    const window = selectTranscriptWindow(messages)

    expect(window.windowed).toBe(true)
    expect(window.messages.length).toBeLessThan(messages.length)
    expect(window.messages.at(-1)).toBe(messages.at(-1))
  })

  it('keeps far MORE messages when they are light than when they are heavy', () => {
    // The contract is weight, not count: a message-count cap would treat these
    // two identically. 500 tiny messages are cheaper than 500 tool results, so
    // many more of them survive the same budget.
    const light = selectTranscriptWindow(transcript(500, 20))
    const heavy = selectTranscriptWindow(transcript(500, RENDER_WEIGHT_CHARS * 40))

    expect(light.messages.length).toBeGreaterThan(heavy.messages.length * 10)
  })

  it('leaves a long transcript whole when the whole thing is cheap', () => {
    const messages = transcript(600, 20)

    const window = selectTranscriptWindow(messages)

    expect(window.windowed).toBe(false)
    expect(window.messages).toBe(messages)
  })

  it('keeps a floor of messages when single turns are enormous', () => {
    const messages = transcript(80, RENDER_WEIGHT_CHARS * TRANSCRIPT_WINDOW_BUDGET)

    const window = selectTranscriptWindow(messages)

    expect(window.messages.length).toBeGreaterThanOrEqual(TRANSCRIPT_WINDOW_MIN_MESSAGES)
  })

  it('grows by one budget page per expand and eventually covers everything', () => {
    const messages = transcript(400, RENDER_WEIGHT_CHARS * 40)

    const first = selectTranscriptWindow(messages, 1)
    const second = selectTranscriptWindow(messages, 2)

    expect(first.windowed).toBe(true)
    expect(second.messages.length).toBeGreaterThan(first.messages.length)

    let pages = 1
    let window = selectTranscriptWindow(messages, pages)

    while (window.windowed && pages < 100) {
      window = selectTranscriptWindow(messages, ++pages)
    }

    // Paging terminates at the full transcript — never a dead end.
    expect(window.windowed).toBe(false)
    expect(window.messages).toHaveLength(messages.length)
  })

  it('handles an empty transcript', () => {
    const messages: ChatMessage[] = []

    expect(selectTranscriptWindow(messages)).toEqual({ messages, windowed: false })
  })
})
