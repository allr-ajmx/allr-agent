import { cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { SyntaxHighlighter } from './shiki-highlighter'

// Streamdown's code adapter hands the highlighter its own `Pre`/`Code` slots
// (adapters/code-adapter.tsx renders bare elements). Mirror that here so the
// test exercises the real element chain rather than a stand-in.
const COMPONENTS = {
  Code: (props: ComponentProps<'code'>) => <code {...props} />,
  Pre: (props: ComponentProps<'pre'>) => <pre {...props} />
} as never

const CODE = ['def first():', '    return 1', '', 'def second():', '    return 2'].join('\n')

// `defer` forces the un-highlighted path, which is what a streaming fence, an
// over-budget fence and a failed engine load all render. Every assertion below
// is about the card around the code, so none of them need Shiki.
function renderFence(code = CODE) {
  return render(<SyntaxHighlighter code={code} components={COMPONENTS} defer language="python" />)
}

afterEach(cleanup)

describe('SyntaxHighlighter', () => {
  it('keeps every line of the fence in the DOM', () => {
    const { container } = renderFence()

    const pre = container.querySelector('pre')!

    expect(pre.textContent).toBe(CODE)
    expect(pre.querySelector('code')).toHaveClass('whitespace-pre')
  })

  it('renders the fence at its natural height — no collapse box, no expand toggle', () => {
    const { container } = renderFence()

    // The ExpandableBlock this replaced clamped the body to `max-h-[7.5rem]`
    // and mounted an Expand/Collapse button once the content overflowed. A
    // fence is scrolled by the transcript viewport now, so neither may return.
    expect(container.querySelector('[class*="max-h-"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /expand|collapse/i })).toBeNull()
  })

  it('drops the card for a fence that is only whitespace', () => {
    const { container } = renderFence('\n  \n')

    expect(container.querySelector('[data-slot="code-card"]')).toBeNull()
  })

  it('renders a prose-ish fence as wrapped text rather than a code card', () => {
    const { container } = render(
      <SyntaxHighlighter
        code={'First sentence here.\nSecond sentence here.\nThird sentence here.'}
        components={COMPONENTS}
        defer
        language=""
      />
    )

    expect(container.querySelector('.aui-prose-fence')).not.toBeNull()
    expect(container.querySelector('[data-slot="code-card"]')).toBeNull()
  })
})
