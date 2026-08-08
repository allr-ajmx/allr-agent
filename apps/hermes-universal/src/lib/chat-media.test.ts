import { describe, expect, it } from 'vitest'

import { renderMediaTags } from '@/lib/chat-media'
import { appendAssistantTextPart, applyCompletion, type ChatMessage, type ChatPart } from '@/store/chat'

function textOf(parts: ChatPart[]): string {
  return parts
    .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    .map(p => p.text)
    .join('')
}

describe('renderMediaTags', () => {
  it('renders standalone and inline MEDIA tags as #media: links', () => {
    expect(renderMediaTags('here\nMEDIA:/tmp/voice.mp3\nthere')).toBe(
      'here\n[Audio: voice.mp3](#media:%2Ftmp%2Fvoice.mp3)\nthere'
    )
    expect(renderMediaTags('audio: MEDIA:/tmp/voice.mp3 done')).toBe(
      'audio: [Audio: voice.mp3](#media:%2Ftmp%2Fvoice.mp3) done'
    )
    expect(renderMediaTags('MEDIA:/tmp/demo.mp4')).toBe('[Video: demo.mp4](#media:%2Ftmp%2Fdemo.mp4)')
  })

  it('handles a real screenshot path (the resume bug)', () => {
    const path = '/opt/data/cache/screenshots/browser_screenshot_eea48a21.png'

    expect(renderMediaTags(`MEDIA:${path}`)).toBe(
      `[Image: browser_screenshot_eea48a21.png](#media:${encodeURIComponent(path)})`
    )
  })

  it('is a no-op on text with no MEDIA marker', () => {
    expect(renderMediaTags('just some text')).toBe('just some text')
  })
})

describe('appendAssistantTextPart', () => {
  it('renders streamed assistant media once the tag is complete', () => {
    const parts = appendAssistantTextPart(appendAssistantTextPart([], 'ok\nMEDIA:'), '/tmp/voice.mp3')

    expect(textOf(parts)).toBe('ok\n[Audio: voice.mp3](#media:%2Ftmp%2Fvoice.mp3)')
  })
})

// The gateway's authoritative final_response still carries raw MEDIA: markers,
// so settling a turn used to overwrite the rendered attachment with literal
// text: the media showed while streaming, then turned back into "MEDIA:/path".
describe('applyCompletion', () => {
  const rendered = 'ok\n[Image: shot.png](#media:%2Ftmp%2Fshot.png)'

  const streamed = (): ChatMessage[] => [
    { id: 'a1', pending: true, role: 'assistant', parts: [{ type: 'text', text: rendered }] }
  ]

  it('renders MEDIA markers in the final response', () => {
    const messages = applyCompletion(streamed(), 'ok\nMEDIA:/tmp/shot.png')

    expect(messages).toHaveLength(1)
    expect(textOf(messages[0].parts)).toBe(rendered)
    expect(messages[0].pending).toBe(false)
  })

  // Same turn arriving twice: the comparison ran rendered-vs-raw and missed, so
  // a trailing completion appended a second bubble holding the raw marker.
  it('settles a trailing completion in place instead of duplicating it', () => {
    const settled = applyCompletion(streamed(), 'ok\nMEDIA:/tmp/shot.png')
    const again = applyCompletion(settled, 'ok\nMEDIA:/tmp/shot.png')

    expect(again).toHaveLength(1)
    expect(textOf(again[0].parts)).toBe(rendered)
  })

  it('leaves prose without a marker exactly as the gateway sent it', () => {
    const messages = applyCompletion(
      [{ id: 'a1', pending: true, role: 'assistant', parts: [] }],
      'one\n\n\ntwo  \nthree'
    )

    expect(textOf(messages[0].parts)).toBe('one\n\n\ntwo  \nthree')
  })
})
