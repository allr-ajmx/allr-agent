import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { referenceRe, WIRE_REFERENCE_KINDS } from '@/components/assistant-ui/reference-kinds'

import { UserMessageText } from './user-message-text'

afterEach(cleanup)

/**
 * A sent reference must render as the chip the composer showed. These cover the
 * seam where that used to break: the composer quotes every chip value
 * (`quoteRefValue` is unconditional), that quoting is directive syntax, and a
 * surface reading it as markdown splits one reference into two wrong things.
 *
 * Adapted from desktop's user-message-text.test.tsx.
 */
describe('a sent reference renders as the chip the composer showed', () => {
  it('chips a backtick-quoted @url: instead of splitting it into code', () => {
    render(<UserMessageText text="@url:`https://github.com/jaxmatrix/mjx-hermes-agent/pull/99` urls lose formatting" />)

    expect(screen.queryByTitle('https://github.com/jaxmatrix/mjx-hermes-agent/pull/99')).not.toBeNull()
    // The whole reference is one node — no bare `@url:` text left behind.
    expect(document.body.textContent).not.toContain('@url:')
  })

  it('chips a backtick-quoted @file: path with spaces', () => {
    render(<UserMessageText text="see @file:`apps/hermes-universal/my notes.md` please" />)

    expect(screen.queryByTitle('apps/hermes-universal/my notes.md')).not.toBeNull()
    expect(document.body.textContent).not.toContain('@file:')
  })

  it('chips every kind that travels in message text', () => {
    // The guard against WIRE_REFERENCE_KINDS and the pattern's own alternation
    // drifting apart: add a kind to one and this fails until both agree.
    for (const kind of WIRE_REFERENCE_KINDS) {
      expect(`@${kind}:\`some value\``.match(referenceRe()), kind).toHaveLength(1)
    }
  })

  it('still renders a genuine code span as code', () => {
    render(<UserMessageText text="run `npm test` first" />)

    const code = document.querySelector('[data-slot="aui_user-inline-code"]')

    expect(code?.textContent).toBe('npm test')
  })

  it('renders code and a reference side by side', () => {
    render(<UserMessageText text="run `npm test` on @file:`apps/hermes-universal/a b.ts` now" />)

    expect(document.querySelector('[data-slot="aui_user-inline-code"]')?.textContent).toBe('npm test')
    expect(screen.queryByTitle('apps/hermes-universal/a b.ts')).not.toBeNull()
  })

  it('leaves a fenced block alone', () => {
    render(<UserMessageText text={'before\n```ts\nconst x = 1\n```\nafter'} />)

    expect(document.querySelector('[data-slot="aui_user-fence"]')?.textContent).toBe('const x = 1\n')
  })
})

/** A reference is one system: the same class and per-kind accent hook, wherever
 *  it renders. The composer half is covered in rich-editor's own suite. */
describe('sent references use the shared `.ref` treatment', () => {
  it('paints a directive chip with the kind accent, not a filled pill', () => {
    render(<UserMessageText text="see @file:`src/a.ts`" />)

    const chip = document.querySelector('[data-slot="aui_directive-chip"]')

    expect(chip?.classList.contains('ref')).toBe(true)
    expect(chip?.getAttribute('data-ref')).toBe('file')
  })

  it('keeps a picked /skill a reference after send', () => {
    render(<UserMessageText text="clean this up with /clean" />)

    const chip = document.querySelector('[data-slot="aui_slash-chip"]')

    expect(chip?.textContent).toBe('clean')
    expect(chip?.getAttribute('data-ref')).toBe('skill')
  })

  it('makes a sent @url: openable rather than a link-coloured no-op', () => {
    render(<UserMessageText text="@url:`https://example.com/a`" />)

    const chip = document.querySelector('[data-slot="aui_directive-chip"]')

    expect(chip?.tagName).toBe('BUTTON')
    expect(chip?.getAttribute('data-ref')).toBe('url')
  })

  it('leaves a kind with nothing to open inert', () => {
    render(<UserMessageText text="@file:`src/a.ts`" />)

    expect(document.querySelector('[data-slot="aui_directive-chip"]')?.tagName).toBe('SPAN')
  })

  it('does not chip a path that only looks like a command', () => {
    render(<UserMessageText text="look in /usr/local/bin" />)

    expect(document.querySelector('[data-slot="aui_slash-chip"]')).toBeNull()
    expect(document.body.textContent).toContain('/usr/local/bin')
  })
})
