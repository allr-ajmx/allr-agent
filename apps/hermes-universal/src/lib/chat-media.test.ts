import { describe, expect, it } from 'vitest'

import { renderMediaTags } from '@/lib/chat-media'
import { appendAssistantTextPart, type ChatPart } from '@/store/chat'

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
