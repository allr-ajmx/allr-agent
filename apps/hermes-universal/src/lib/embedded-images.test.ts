import { describe, expect, it } from 'vitest'

import { extractEmbeddedImages } from './embedded-images'

// Ported from apps/desktop/src/lib/embedded-images.test.ts. Universal's module is
// desktop's minus the `extractImageRefs` tail, so only the `extractEmbeddedImages`
// half comes across — universal renders a persisted `@image:` directive line
// through `DirectiveContent` (components/assistant-ui/directive-content.tsx)
// instead of lifting it into `attachmentRefs` metadata, so there is no
// `extractImageRefs` to test here.
//
// The reachable callers of this module in universal are `lib/live-tail.ts`
// (embeddedImageUrls / textWithoutEmbeddedImages), `directive-content.tsx`
// (extractEmbeddedImages) and the composer's paste path (DATA_IMAGE_URL_RE).

const SAMPLE_PNG_DATA_URL = 'data:image/png;base64,' + 'A'.repeat(120)

describe('extractEmbeddedImages', () => {
  it('returns text untouched when no data URL is present', () => {
    expect(extractEmbeddedImages('describe this')).toEqual({ cleanedText: 'describe this', images: [] })
  })

  it('lifts a bare data:image URL out of prose', () => {
    const result = extractEmbeddedImages(`describe this ${SAMPLE_PNG_DATA_URL}`)

    expect(result.cleanedText).toBe('describe this')
    expect(result.images).toEqual([SAMPLE_PNG_DATA_URL])
  })

  it('lifts a JSON-wrapped image_url envelope out of prose', () => {
    const result = extractEmbeddedImages(
      `describe this{"type":"image_url","image_url":{"url":"${SAMPLE_PNG_DATA_URL}"}}`
    )

    expect(result.cleanedText).toBe('describe this')
    expect(result.images).toEqual([SAMPLE_PNG_DATA_URL])
  })

  it('extracts multiple embedded images', () => {
    const second = 'data:image/jpeg;base64,' + 'B'.repeat(96)
    const result = extractEmbeddedImages(`first ${SAMPLE_PNG_DATA_URL} mid ${second} tail`)

    expect(result.cleanedText).toBe('first  mid  tail')
    expect(result.images).toEqual([SAMPLE_PNG_DATA_URL, second])
  })

  it('handles multi-megabyte data URLs without overflowing the JS stack', () => {
    const hugeDataUrl = 'data:image/png;base64,' + 'A'.repeat(8_000_000)
    const result = extractEmbeddedImages(`describe this ${hugeDataUrl} thanks`)

    expect(result.cleanedText).toBe('describe this  thanks')
    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toHaveLength(hugeDataUrl.length)
  })
})
