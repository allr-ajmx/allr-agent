import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MAX_HIGHLIGHT_LINES } from '@/lib/code-budget'

import { PreviewSource } from './preview-source'

/**
 * ALLR-40: opening a file showed the toolbar on `source` with an EMPTY content
 * area, and tapping Edit (CodeMirror) filled it. jsdom does no layout, so
 * nothing here can SEE the pane collapse — what it can assert is the contract
 * that makes an empty pane unreachable: every path renders the file's text into
 * DOM this app owns, synchronously, with the geometry inline.
 */

const CODE = ['def first():', '    return 1', '', 'def second():', '    return 2'].join('\n')

function renderSource(props: { language: string; text: string }) {
  const { container } = render(<PreviewSource {...props} />)

  return {
    code: container.querySelector<HTMLElement>('[data-slot="preview-source-code"]'),
    container,
    pre: container.querySelector<HTMLElement>('[data-slot="preview-source-pre"]')
  }
}

describe('PreviewSource — the empty-pane contract', () => {
  it('renders the file synchronously, with no Suspense boundary to be stuck in', () => {
    // The old view was `lazy()` around react-shiki behind a `<Suspense>`. A
    // single render pass has to produce the whole file.
    const { code } = renderSource({ language: 'python', text: CODE })

    expect(code?.textContent).toBe(CODE)
  })

  it('renders a language `code-tokens` has no grammar for as plain, complete text', () => {
    // THE trap. `react-shiki` accepted anything in `bundledLanguages`;
    // `canTokenize` recognises a much shorter list, and `lua` (which the pane's
    // own extension map produces) is not on it. An unrecognised language must
    // fall through to readable text — never to nothing.
    const { code, pre } = renderSource({ language: 'lua', text: CODE })

    expect(pre?.dataset.highlight).toBe('unsupported')
    expect(code?.textContent).toBe(CODE)
  })

  it('renders a language nobody could have meant as plain, complete text', () => {
    for (const language of ['', 'text', 'not-a-real-language']) {
      const { code } = renderSource({ language, text: CODE })

      expect(code?.textContent).toBe(CODE)
    }
  })

  it('stays readable past the highlight budget, in the same DOM', () => {
    // A large file once froze the whole app, not just the pane. Over budget it
    // skips tokenizing — but it is the same <pre>/<code>, so nothing moves.
    const big = Array.from({ length: MAX_HIGHLIGHT_LINES + 10 }, (_, i) => `line ${i}`).join('\n')
    const { code, pre } = renderSource({ language: 'typescript', text: big })

    expect(pre?.dataset.highlight).toBe('over-budget')
    expect(code?.textContent).toBe(big)
  })

  it('loses no character when it DOES tokenize', () => {
    // `tokenizeCode` returns a partition of the input; this is that property
    // observed through the DOM, which is what the user actually reads.
    const { code, pre } = renderSource({ language: 'typescript', text: CODE })

    expect(pre?.dataset.highlight).toBe('tokens')
    expect(code?.textContent).toBe(CODE)
  })

  it('carries white-space:pre as an INLINE style on the element holding the text', () => {
    // The whole of ALLR-30, and the reason it shipped: the contract was a class
    // and nothing asserted it. `.style` is the attribute, not the cascade.
    const { code, pre } = renderSource({ language: 'python', text: CODE })

    expect(code?.style.whiteSpace).toBe('pre')
    expect(pre?.style.whiteSpace).toBe('pre')
    expect(code?.className).not.toMatch(/whitespace/)
    expect(pre?.className).not.toMatch(/whitespace/)
  })

  it('pins the inherited wrapping properties and the row height inline', () => {
    const { code, pre } = renderSource({ language: 'python', text: CODE })

    expect(code?.style.wordBreak).toBe('normal')
    expect(code?.style.overflowWrap).toBe('normal')
    expect(code?.style.minWidth).toBe('max-content')
    // The fixed editor row height the deleted `.preview-source-code` rules used
    // to supply, so source⇄diff toggling does not shift.
    expect(pre?.style.lineHeight).toBe('1.25rem')
    expect(pre?.style.height).toBe('100%')
  })

  it('puts nothing third-party between the <pre> and the text', () => {
    // The DOM ALLR-30 was fighting was <pre> → div → pre → code → span. Here the
    // <pre> is the code element's only ancestor inside this component, and the
    // only elements under <code> are our own colour spans.
    const { code, container, pre } = renderSource({ language: 'typescript', text: CODE })

    expect(pre?.tagName).toBe('PRE')
    expect(container.firstElementChild).toBe(pre)
    expect(code?.parentElement).toBe(pre)
    expect([...(code?.querySelectorAll('*') ?? [])].every(el => el.tagName === 'SPAN')).toBe(true)
  })
})
