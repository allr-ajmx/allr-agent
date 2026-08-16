import { afterEach, describe, expect, it } from 'vitest'

import { setReactionsEnabled } from '@/store/reactions-enabled'

import { blobDedupeKey, detectTrigger, extractClipboardImageBlobs, mayContainTrigger } from './text-utils'

describe('detectTrigger', () => {
  it('detects a bare slash trigger with an empty query', () => {
    expect(detectTrigger('/')).toEqual({ kind: '/', query: '', tokenLength: 1, value: '' })
  })

  it('detects a slash command query', () => {
    expect(detectTrigger('/skill')).toEqual({ kind: '/', query: 'skill', tokenLength: 6, value: 'skill' })
  })

  it('detects a bare at-mention trigger with an empty query', () => {
    expect(detectTrigger('@')).toEqual({ kind: '@', query: '', tokenLength: 1, value: '' })
  })

  it('detects an at-mention query', () => {
    expect(detectTrigger('@file')).toEqual({ kind: '@', query: 'file', tokenLength: 5, value: 'file' })
  })

  it('returns null for plain text', () => {
    expect(detectTrigger('hello there')).toBeNull()
  })

  it('keeps the slash trigger live while typing args', () => {
    expect(detectTrigger('/personality ')).toEqual({
      kind: '/',
      query: 'personality ',
      tokenLength: 13,
      value: 'personality '
    })
    expect(detectTrigger('/personality alic')).toEqual({
      kind: '/',
      query: 'personality alic',
      tokenLength: 17,
      value: 'personality alic'
    })
    expect(detectTrigger('/tools enable foo')).toEqual({
      kind: '/',
      query: 'tools enable foo',
      tokenLength: 17,
      value: 'tools enable foo'
    })
  })

  it('does not treat file-style paths as slash triggers', () => {
    expect(detectTrigger('src/foo/bar')).toBeNull()
    expect(detectTrigger('/path/to/file')).toBeNull()
    // Mid-message paths stay excluded too: a path keeps going past the command
    // token, so the trailing-anchored inline trigger never matches it.
    expect(detectTrigger('check src/foo/bar')).toBeNull()
    expect(detectTrigger('look at /usr/local/bin')).toBeNull()
    expect(detectTrigger('and/or')).toBeNull()
  })

  it('keeps the at-mention live while walking into subfolders', () => {
    // A `/` inside the query is path navigation, not the end of the token —
    // the popover has to stay open so the next directory level can load.
    expect(detectTrigger('@./')).toEqual({ kind: '@', query: './', tokenLength: 3, value: './' })
    expect(detectTrigger('@./src')).toEqual({ kind: '@', query: './src', tokenLength: 6, value: './src' })
    expect(detectTrigger('@~/Desktop/')).toEqual({
      kind: '@',
      query: '~/Desktop/',
      tokenLength: 11,
      value: '~/Desktop/'
    })
    expect(detectTrigger('@/usr/local')).toEqual({
      kind: '@',
      query: '/usr/local',
      tokenLength: 11,
      value: '/usr/local'
    })
    expect(detectTrigger('@apps/desktop/src')).toEqual({
      kind: '@',
      query: 'apps/desktop/src',
      tokenLength: 17,
      value: 'apps/desktop/src'
    })
  })

  it('treats a chip edge as a token boundary, like whitespace', () => {
    // U+FFFC is textBeforeCaret's placeholder for a committed pill. Upstream
    // assistant-ui's Lexical DirectivePlugin gets the same semantics from node
    // boundaries: typing a trigger right after a chip (no space) still opens
    // the popover, and a chip inside a token ends it.
    expect(detectTrigger('\uFFFC@Desk')).toEqual({ kind: '@', query: 'Desk', tokenLength: 5, value: 'Desk' })
    // Not position 0, so it reads as an inline skill reference (MJXHRM-304).
    expect(detectTrigger('\uFFFC/cle')).toEqual({
      inline: true,
      kind: '/',
      query: 'cle',
      tokenLength: 4,
      value: 'cle'
    })
    // The placeholder itself never leaks into a query.
    expect(detectTrigger('@a\uFFFCb')).toBeNull()
  })

  it('splits a typed ref kind off as the browse scope', () => {
    // `@folder:apps/` is ONE token with TWO parts. The kind is the mode the
    // user is browsing in, so it's held as `scope` rather than left in `value`
    // for every consumer to re-parse (or, worse, to preserve by hand).
    expect(detectTrigger('@file:src/main.tsx')).toEqual({
      kind: '@',
      query: 'file:src/main.tsx',
      scope: 'file',
      tokenLength: 18,
      value: 'src/main.tsx'
    })
    expect(detectTrigger('@folder:apps/')).toEqual({
      kind: '@',
      query: 'folder:apps/',
      scope: 'folder',
      tokenLength: 13,
      value: 'apps/'
    })
    // A scope with nothing typed after it is the empty-browse state the
    // popover renders a header for.
    expect(detectTrigger('@url:')).toEqual({ kind: '@', query: 'url:', scope: 'url', tokenLength: 5, value: '' })
  })

  it('only treats a KNOWN kind as a scope', () => {
    // `@teknium1:` is a handle with a colon, not a directive — inventing a
    // scope for it would make Backspace eat the whole word.
    expect(detectTrigger('@teknium1:')?.scope).toBeUndefined()
    expect(detectTrigger('@teknium1:')?.value).toBe('teknium1:')
    expect(detectTrigger('@localhost:8080')?.scope).toBeUndefined()
  })

  it('still ends the at-mention token at whitespace', () => {
    // The token is whitespace-delimited; a path doesn't change that.
    expect(detectTrigger('@./src and more')).toBeNull()
    expect(detectTrigger('look at @apps/desktop')).toEqual({
      kind: '@',
      query: 'apps/desktop',
      tokenLength: 13,
      value: 'apps/desktop'
    })
  })

  // MJXHRM-304: the second `/` shape. A slash after whitespace is an inline
  // skill REFERENCE dropped into prose, not a command invocation — the popover
  // filters to skills there (use-composer-trigger), because a built-in like
  // `/new` acts on the app and means nothing mid-sentence.
  it('opens an inline slash trigger mid-message', () => {
    expect(detectTrigger('hello /')).toEqual({ inline: true, kind: '/', query: '', tokenLength: 1, value: '' })
    expect(detectTrigger('hello /clean')).toEqual({
      inline: true,
      kind: '/',
      query: 'clean',
      tokenLength: 6,
      value: 'clean'
    })
    expect(detectTrigger('text\n/skill')?.inline).toBe(true)
  })

  it('keeps a position-0 slash a command invocation, not an inline reference', () => {
    expect(detectTrigger('/personality alic')).toEqual({
      kind: '/',
      query: 'personality alic',
      tokenLength: 17,
      value: 'personality alic'
    })
  })

  it('does not carry arg completion into an inline slash reference', () => {
    // Only a position-0 slash is a real invocation, so `/personality alic`
    // mid-message is prose — the inline trigger ends at the command token, and
    // a query with a space in it can no longer match at all.
    expect(detectTrigger('hello there /personality alic')).toBeNull()
    expect(detectTrigger('run /tools enable foo')).toBeNull()
  })

  it('finds the LAST slash, so a leading command does not swallow a later skill', () => {
    // The command regex's argument tail (`(?:\s+\S*)*`) matches `/work /cle`
    // whole, which used to silence completion for every slash after the first.
    expect(detectTrigger('/work /cle')).toEqual({
      inline: true,
      kind: '/',
      query: 'cle',
      tokenLength: 4,
      value: 'cle'
    })
  })

  it('still anchors at-mention triggers strictly at the token edge', () => {
    expect(detectTrigger('@file:path with space')).toBeNull()
  })
})

describe('extractClipboardImageBlobs', () => {
  it('dedupes the same image exposed on both items and files', () => {
    const image = new File([new Uint8Array([1, 2, 3])], 'paste.png', {
      type: 'image/png',
      lastModified: 1_700_000_000_000
    })

    const clipboard = {
      files: {
        length: 1,
        item: (index: number) => (index === 0 ? image : null)
      },
      getData: () => '',
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => image
        }
      ]
    } as unknown as DataTransfer

    expect(extractClipboardImageBlobs(clipboard)).toEqual([image])
  })

  it('falls back to files when items has no image', () => {
    const image = new File([new Uint8Array([4, 5])], 'shot.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_000_001
    })

    const clipboard = {
      files: {
        length: 1,
        item: (index: number) => (index === 0 ? image : null)
      },
      getData: () => '',
      items: []
    } as unknown as DataTransfer

    expect(extractClipboardImageBlobs(clipboard)).toEqual([image])
  })

  // A rich-text copy (Discord thread, web page, doc) carries prose plus whatever
  // inline images the page decorated it with. That is a TEXT paste: attaching the
  // page's placeholder graphics as composer images while the text vanished is the
  // "blank attachments, no message" bug.
  it('ignores inline HTML images when the copy carries its own text', () => {
    const clipboard = {
      files: { length: 0, item: () => null },
      getData: (type: string) =>
        type === 'text/html'
          ? `<p>hello from the thread</p><img src="data:image/png;base64,${'A'.repeat(20_000)}">`
          : 'hello from the thread',
      items: []
    } as unknown as DataTransfer

    expect(extractClipboardImageBlobs(clipboard)).toEqual([])
  })

  it('keeps inline HTML images when the copy is image-only', () => {
    const clipboard = {
      files: { length: 0, item: () => null },
      getData: (type: string) =>
        type === 'text/html' ? `<img src="data:image/png;base64,${'A'.repeat(20_000)}">` : '',
      items: []
    } as unknown as DataTransfer

    const blobs = extractClipboardImageBlobs(clipboard)

    expect(blobs).toHaveLength(1)
    expect(blobs[0]?.type).toBe('image/png')
  })

  it('drops sub-thumbnail inline images — spacers, trackers, blurhash placeholders', () => {
    const clipboard = {
      files: { length: 0, item: () => null },
      getData: (type: string) => (type === 'text/html' ? `<img src="data:image/png;base64,${'A'.repeat(64)}">` : ''),
      items: []
    } as unknown as DataTransfer

    expect(extractClipboardImageBlobs(clipboard)).toEqual([])
  })
})

describe('blobDedupeKey', () => {
  it('uses file metadata for File blobs', () => {
    const file = new File([], 'a.png', { type: 'image/png', lastModified: 42 })

    expect(blobDedupeKey(file)).toBe('file:a.png:0:image/png:42')
  })
})

/**
 * The `:shortcode:` trigger and the cheap screen that guards it.
 *
 * The screen used to live in `use-composer-trigger`, listing `@` and `/` only,
 * so it discarded every emoji trigger before `detectTrigger` could match one.
 * It lives beside the regexes now precisely so the two cannot drift again —
 * these tests hold them together.
 */
describe('the `:` emoji trigger', () => {
  afterEach(() => {
    setReactionsEnabled(false)
  })

  it('matches a shortcode of two characters or more', () => {
    setReactionsEnabled(true)

    expect(detectTrigger(':jo')).toEqual({ kind: ':', query: 'jo', tokenLength: 3, value: 'jo' })
    expect(detectTrigger('nice :tada')).toEqual({ kind: ':', query: 'tada', tokenLength: 5, value: 'tada' })
    expect(detectTrigger('\uFFFC:jo')).toEqual({ kind: ':', query: 'jo', tokenLength: 3, value: 'jo' })
  })

  it('needs two characters, so a bare colon and a clock time stay quiet', () => {
    setReactionsEnabled(true)

    expect(detectTrigger(':')).toBeNull()
    expect(detectTrigger(':j')).toBeNull()
    expect(detectTrigger('12:30')).toBeNull()
    expect(detectTrigger('http://ex')).toBeNull()
  })

  it("yields to `@` — a directive starter's colon is part of the @ query", () => {
    setReactionsEnabled(true)

    expect(detectTrigger('@file:')?.kind).toBe('@')
    expect(detectTrigger('@folder:src')?.kind).toBe('@')
  })

  it('is off unless the emoji surface is on', () => {
    expect(detectTrigger(':joy')).toBeNull()

    setReactionsEnabled(true)

    expect(detectTrigger(':joy')?.kind).toBe(':')
  })
})

describe('mayContainTrigger', () => {
  afterEach(() => {
    setReactionsEnabled(false)
  })

  it('admits anything holding an @ or a /', () => {
    expect(mayContainTrigger('mail me @ home')).toBe(true)
    expect(mayContainTrigger('src/foo')).toBe(true)
  })

  it('rejects prose with no trigger character at all', () => {
    expect(mayContainTrigger('hello there')).toBe(false)
  })

  it('admits a colon only while the emoji surface is on', () => {
    expect(mayContainTrigger('hello :jo')).toBe(false)

    setReactionsEnabled(true)

    expect(mayContainTrigger('hello :jo')).toBe(true)
  })

  it('never rejects text `detectTrigger` would have matched', () => {
    setReactionsEnabled(true)

    for (const text of ['@', '/', 'hi /skill', '@file:src', 'hello :jo', '\uFFFC:tada']) {
      expect(mayContainTrigger(text), text).toBe(true)
    }
  })
})
