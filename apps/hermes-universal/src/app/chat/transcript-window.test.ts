import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { RENDER_WEIGHT_CHARS } from '@/lib/render-weight'

import {
  advanceTranscriptWindow,
  selectTranscriptWindow,
  TRANSCRIPT_WINDOW_BUDGET,
  TRANSCRIPT_WINDOW_MIN_MESSAGES,
  TRANSCRIPT_WINDOW_SLACK
} from './transcript-window'

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

describe('advanceTranscriptWindow', () => {
  /** One message ≈ 11 weight units, so a page is ~110 of them. */
  const CHARS = RENDER_WEIGHT_CHARS * 10

  /** One weight unit shy of a full slack page's worth of streamed messages. */
  const STREAMED_UNDER_SLACK = Math.floor(TRANSCRIPT_WINDOW_SLACK / (CHARS / RENDER_WEIGHT_CHARS + 1)) - 2

  it('holds the cut steady while a turn streams instead of sliding it per flush', () => {
    const messages = transcript(200, CHARS)

    let state = advanceTranscriptWindow(null, messages, 1)
    const firstCut = state.window.messages[0].id

    expect(state.window.windowed).toBe(true)
    expect(state.anchorId).toBe(firstCut)

    // Every flush of a streaming turn republishes a LONGER array. A fresh weight
    // walk moves the cut one message per flush and re-indexes the whole window;
    // the anchor has to survive until the tail is a real half-page heavier.
    const streaming = [...messages]

    for (let i = 1; i <= STREAMED_UNDER_SLACK; i++) {
      streaming.push(message(`live-${i}`, CHARS))
      state = advanceTranscriptWindow(state, streaming, 1)
    }

    expect(state.window.messages[0].id).toBe(firstCut)
    expect(state.anchorId).toBe(firstCut)
    // A fresh walk over the same transcript HAS moved on — which is the slide
    // this exists to stop, so the two must disagree by now.
    expect(selectTranscriptWindow(streaming, 1).messages[0].id).not.toBe(firstCut)
  })

  it('re-cuts once the tail has outgrown the budget by a slack page', () => {
    const messages = transcript(200, CHARS)

    const first = advanceTranscriptWindow(null, messages, 1)
    const streaming = [...messages]

    // Twice the slack: comfortably past the point where the anchor must move.
    for (let i = 1; i <= STREAMED_UNDER_SLACK * 2 + 8; i++) {
      streaming.push(message(`live-${i}`, CHARS))
    }

    const next = advanceTranscriptWindow(first, streaming, 1)

    expect(next.window.messages[0].id).not.toBe(first.window.messages[0].id)
    expect(next.anchorId).toBe(next.window.messages[0].id)
    // Still exactly the cut a fresh walk would make.
    expect(next.window.messages.map(m => m.id)).toEqual(selectTranscriptWindow(streaming, 1).messages.map(m => m.id))
  })

  it('re-walks when "Show earlier" changes the page count', () => {
    const messages = transcript(200, CHARS)

    const first = advanceTranscriptWindow(null, messages, 1)
    const second = advanceTranscriptWindow(first, messages, 2)

    expect(second.pages).toBe(2)
    expect(second.window.messages.length).toBeGreaterThan(first.window.messages.length)
  })

  it('re-walks when the anchor is rewritten out from under it', () => {
    const messages = transcript(200, CHARS)

    const first = advanceTranscriptWindow(null, messages, 1)
    // A compaction replaces the transcript wholesale: the anchor id is gone.
    const rewritten = transcript(200, CHARS).map(m => ({ ...m, id: `${m.id}-v2` }))
    const next = advanceTranscriptWindow(first, rewritten, 1)

    expect(next.anchorId).toBe(next.window.messages[0].id)
    expect(next.window.messages[0].id).toContain('-v2')
  })

  it('reports nothing earlier once a compaction leaves the anchor at the head', () => {
    const messages = transcript(200, CHARS)
    const first = advanceTranscriptWindow(null, messages, 1)
    const anchorIndex = messages.findIndex(m => m.id === first.anchorId)

    // The history before the cut is dropped; the anchor is now the first row, so
    // there is no earlier page and the button must not offer one.
    const next = advanceTranscriptWindow(first, messages.slice(anchorIndex), 1)

    expect(next.window.windowed).toBe(false)
    expect(next.window.messages[0].id).toBe(first.anchorId)
  })

  it('leaves a transcript under the budget completely uncut', () => {
    const messages = transcript(20, 20)

    const first = advanceTranscriptWindow(null, messages, 1)
    const second = advanceTranscriptWindow(first, messages, 1)

    expect(first.anchorId).toBeNull()
    expect(second.window.windowed).toBe(false)
    expect(second.window.messages).toBe(messages)
  })
})
