import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type * as CodeTokens from '@/lib/code-tokens'

import { CodeFence, type CodeFenceProps } from './code-fence'

/**
 * jsdom does no layout, so no test in here can SEE a fence collapse onto one
 * line. What it can do is assert the contract that prevents one — and the
 * reason ALLR-30 shipped is that the contract was a Tailwind class and nothing
 * asserted it.
 */

const CODE = ['def first():', '    return 1', '', 'def second():', '    return 2'].join('\n')

function renderFence(props: Partial<CodeFenceProps> = {}) {
  const { container } = render(<CodeFence code={CODE} language="python" {...props} />)

  return {
    card: container.querySelector('[data-slot="code-card"]'),
    code: container.querySelector<HTMLElement>('[data-slot="code-fence-code"]'),
    container,
    pre: container.querySelector<HTMLElement>('[data-slot="code-fence-pre"]')
  }
}

describe('CodeFence — the line-collapse contract', () => {
  it('carries white-space:pre as an INLINE style on the element holding the text', () => {
    const { code, pre } = renderFence()

    // `.style` is the attribute, not the computed cascade: this asserts the
    // declaration is ON the element, where no build step can reach it.
    expect(code?.style.whiteSpace).toBe('pre')
    expect(code?.getAttribute('style')).toMatch(/white-space:\s*pre/)

    // And again on the <pre>, so neither element alone is a single point of failure.
    expect(pre?.style.whiteSpace).toBe('pre')
  })

  it('does not delegate line breaking to a utility class', () => {
    // The whole of ALLR-30. A class can be purged by content detection,
    // rewritten by Lightning CSS, out-ranked by a layer, or scoped to a
    // selector that stops matching. An inline style survives all four.
    const { code, pre } = renderFence()

    expect(code?.className).not.toMatch(/whitespace/)
    expect(pre?.className).not.toMatch(/whitespace/)
  })

  it('pins the inherited wrapping properties too', () => {
    // `word-break` and `overflow-wrap` INHERIT, and this transcript is full of
    // `wrap-anywhere`; an ancestor gaining one would reflow code mid-identifier.
    const { code } = renderFence()

    expect(code?.style.wordBreak).toBe('normal')
    expect(code?.style.overflowWrap).toBe('normal')
  })

  it('names both overflow axes so the fence never grows a second vertical scroller', () => {
    const { pre } = renderFence()

    expect(pre?.style.overflowX).toBe('auto')
    expect(pre?.style.overflowY).toBe('hidden')
  })

  it('puts no third-party element between the <pre> and the text', () => {
    const { pre } = renderFence()

    // No nested <pre>, no rs-root wrapper, no streamdown chrome.
    expect(pre?.querySelector('pre, div')).toBeNull()
    expect(pre?.querySelector('[class*="shiki"], [data-streamdown]')).toBeNull()
    expect(pre?.firstElementChild?.getAttribute('data-slot')).toBe('code-fence-code')
  })

  it('renders the text into a real <pre>, which inline-code chrome depends on', () => {
    // styles.css has `.aui-md :not(pre) > code { ...inline-code chrome... }`, so
    // a <div> dressed as a <pre> would paint a pill behind every fence token.
    const { code, pre } = renderFence()

    expect(pre?.tagName).toBe('PRE')
    expect(code?.tagName).toBe('CODE')
    expect(code?.parentElement).toBe(pre)
  })
})

describe('CodeFence — text fidelity', () => {
  it('emits byte-identical text whether or not it found colours', () => {
    // Layer 1 is a colouring of Layer 0's character stream and nothing more, so
    // the two paths cannot differ by a character or a newline.
    expect(renderFence({ language: 'python' }).code?.textContent).toBe(CODE)
    expect(renderFence({ language: 'brainfuck' }).code?.textContent).toBe(CODE)
    expect(renderFence({ streaming: true }).code?.textContent).toBe(CODE)
  })

  it('reports its line count', () => {
    expect(renderFence().code?.getAttribute('data-lines')).toBe('5')
  })

  it('colours tokens with custom properties that fall back to the text colour', () => {
    const { code } = renderFence()
    const spans = [...(code?.querySelectorAll('span') ?? [])]

    expect(spans.length).toBeGreaterThan(0)

    for (const span of spans) {
      expect(span.getAttribute('style')).toMatch(/var\(--code-[a-z]+, ?currentColor\)/)
    }
  })
})

describe('CodeFence — never an empty card', () => {
  it.each<[string, Partial<CodeFenceProps>]>([
    ['while streaming', { streaming: true }],
    ['over the highlight budget', { code: `${CODE}\n${'filler\n'.repeat(4000)}` }],
    ['with no language tag', { language: '' }],
    ['with a language it has no grammar for', { language: 'brainfuck' }],
    ['with a language tag that sanitizes away', { language: '!!! not a tag !!!' }]
  ])('renders the code %s', (_label, props) => {
    const { card, code } = renderFence(props)

    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('return 1')
    expect(code?.textContent).toContain('def second():')
  })

  it('sheds its colours rather than its content if the tokenizer regresses', async () => {
    vi.resetModules()
    vi.doMock('@/lib/code-tokens', async importOriginal => ({
      ...(await importOriginal<typeof CodeTokens>()),
      tokenizeCode: () => {
        throw new Error('boom')
      }
    }))

    const { CodeFence: Regressed } = await import('./code-fence')
    const { container } = render(<Regressed code={CODE} language="python" />)
    const code = container.querySelector<HTMLElement>('[data-slot="code-fence-code"]')

    // There is no ErrorBoundary above the fence any more; the nearest one is
    // the turn-level MessageRenderBoundary, which would take the whole reply's
    // markdown down with it. So a throw must not escape the fence.
    expect(code?.textContent).toBe(CODE)
    expect(code?.style.whiteSpace).toBe('pre')
    expect(container.querySelector('[data-slot="code-fence-pre"]')?.getAttribute('data-highlight')).toBe('plain')

    vi.doUnmock('@/lib/code-tokens')
    vi.resetModules()
  })
})

describe('CodeFence — states and escapes', () => {
  it('labels which path it took', () => {
    expect(renderFence().pre?.dataset.highlight).toBe('tokens')
    expect(renderFence({ streaming: true }).pre?.dataset.highlight).toBe('streaming')
    expect(renderFence({ language: 'brainfuck' }).pre?.dataset.highlight).toBe('unsupported')
    expect(renderFence({ code: `${CODE}\n${'filler\n'.repeat(4000)}` }).pre?.dataset.highlight).toBe('over-budget')
  })

  it('renders nothing for an empty or whitespace-only fence', () => {
    expect(renderFence({ code: '' }).container.innerHTML).toBe('')
    expect(renderFence({ code: '\n\n   \n' }).container.innerHTML).toBe('')
  })

  it('renders fence-shaped prose as wrapped text rather than a card', () => {
    const prose = 'First sentence here.\nSecond sentence here.\nThird sentence here.'
    const { card, container } = renderFence({ code: prose, language: '' })

    expect(card).toBeNull()
    expect(container.querySelector('.aui-prose-fence')?.textContent).toBe(prose)
  })

  it('keeps the prose escape optional for hosts that asked to see a file', () => {
    const prose = 'First sentence here.\nSecond sentence here.\nThird sentence here.'
    const { card } = renderFence({ code: prose, language: '', proseEscape: false })

    expect(card).not.toBeNull()
  })

  it('omits the copy control when the host provides its own', () => {
    expect(renderFence().container.querySelector('button')).not.toBeNull()
    expect(renderFence({ copy: false }).container.querySelector('button')).toBeNull()
  })

  it('stands at its natural height — no clamp, no expand toggle', () => {
    // A fence long enough to drown a reply is promoted to an artifact upstream
    // (lib/artifact-detect.ts). Two nested scrollers on a phone was the problem.
    const { card } = renderFence({ code: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') })

    expect(card?.innerHTML).not.toMatch(/max-h-|line-clamp/)
    expect(card?.querySelectorAll('button')).toHaveLength(1)
  })

  it('pins the fence left-to-right regardless of locale direction', () => {
    expect(renderFence().pre?.getAttribute('dir')).toBe('ltr')
  })
})
