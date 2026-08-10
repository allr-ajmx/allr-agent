import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import fixture from '@/dev/fixtures/latex-heavy.md?raw'

import { MarkdownTextContent } from './markdown-text'

const renderMarkdown = async (text: string) => {
  const { container } = render(<MarkdownTextContent isRunning={false} text={text} />)

  await waitFor(() => expect(container.querySelector('.katex-host')).not.toBeNull())

  return container
}

// End-to-end through the REAL streamdown pipeline, not just the rehype plugin.
// The load-bearing claim being tested is that our custom `katex-html` tag
// survives streamdown's rehype-sanitize pass — it only does because streamdown
// appends the math plugin AFTER sanitize. If that ever changes, the sanitizer
// unwraps the tag and the KaTeX markup leaks out as escaped text; these tests
// fail loudly instead of shipping visibly broken equations.
describe('MarkdownTextContent math rendering', () => {
  it('renders inline math through a single host element', async () => {
    const container = await renderMarkdown('The capacitance $C_{dl}$ scales with area.')

    const hosts = container.querySelectorAll('.katex-host')

    expect(hosts).toHaveLength(1)
    expect(hosts[0].getAttribute('data-display')).toBe('false')
    // Real KaTeX markup reached the DOM rather than being escaped to text.
    expect(hosts[0].querySelector('.katex')).not.toBeNull()
    expect(container.textContent).toContain('scales with area')
  })

  it('renders fenced display math as a block host', async () => {
    const container = await renderMarkdown('```math\nECSA = \\frac{C_{dl}}{C_s}\n```')
    const host = container.querySelector('.katex-host')

    expect(host?.getAttribute('data-display')).toBe('true')
    expect(host?.querySelector('.katex')).not.toBeNull()
  })

  it('renders multi-line $$…$$ as a block host', async () => {
    const container = await renderMarkdown('$$\nECSA = \\frac{C_{dl}}{C_s}\n$$')

    expect(container.querySelector('.katex-host')?.getAttribute('data-display')).toBe('true')
  })

  // remark-math classes a single-line `$$x$$` as math-inline — only the
  // multi-line form gets math-display — so a standalone equation rendered as
  // small in-flow math. `promoteStandaloneDisplayMath` in the preprocess
  // rewrites a whole-paragraph `$$x$$` to the multi-line form to fix that.
  it('renders a standalone single-line $$…$$ as display math', async () => {
    const container = await renderMarkdown('$$ECSA = \\frac{C_{dl}}{C_s}$$')

    expect(container.querySelector('.katex-host')?.getAttribute('data-display')).toBe('true')
  })

  // The promotion is paragraph-scoped: mid-sentence it must stay inline, since
  // promoting there would split the paragraph rather than restyle an equation.
  it('leaves mid-sentence $$…$$ inline', async () => {
    const container = await renderMarkdown('the identity $$x^2$$ holds here')

    expect(container.querySelector('.katex-host')?.getAttribute('data-display')).toBe('false')
  })

  // The upstream currency escape ate any math opening with a digit; this row
  // used to render as literal `$5–\50,\Omega$` text.
  it('renders digit-leading math in a table instead of escaping it as currency', async () => {
    const container = await renderMarkdown('| a | b |\n| --- | --- |\n| $R_s$ | $5$–$50\\,\\Omega$ |')

    // Three equations in the row; the old behaviour escaped the digit-leading
    // two into prose, leaving only `$R_s$` as real math.
    expect(container.querySelectorAll('.katex-host')).toHaveLength(3)
    // A leaked currency escape shows up as a literal backslash-dollar.
    expect(container.textContent).not.toContain('\\$')
  })

  it('does not leak KaTeX markup as visible text', async () => {
    const container = await renderMarkdown('Consider $R_{ct}$ and $Z_W$ together.')

    // The sanitizer-unwrapped failure mode shows up as literal tag text.
    expect(container.textContent).not.toContain('<span')
    expect(container.textContent).not.toContain('katex-html')
  })

  // MarkdownSyntaxHighlighter reads the streaming flag from the aui store while
  // rendered deep inside streamdown's block tree. If that context didn't reach
  // (portal, detached render) or the selector shape were wrong, this throws
  // rather than rendering — so a passing render is the assertion that matters.
  it('renders a code fence, resolving streaming state from context', async () => {
    const { container } = render(
      <MarkdownTextContent isRunning={false} text={'Here:\n\n```python\nprint("hi")\n```\n'} />
    )

    // Assert on the fence's CONTENT, not its language tag: the code card is
    // background-only now (no header row, no language label), so `python`
    // never appears as text.
    await waitFor(() => expect(container.textContent).toContain('print("hi")'))
  })

  it('keeps the whole LaTeX-heavy fixture on one node per equation', async () => {
    const container = await renderMarkdown(fixture)

    const hosts = container.querySelectorAll('.katex-host')

    // The fixture is dense with math; if the plugin silently stopped matching,
    // this collapses to zero.
    expect(hosts.length).toBeGreaterThan(20)

    // Every host holds exactly one KaTeX root, and no host nests another —
    // i.e. one equation really is one node.
    for (const host of hosts) {
      expect(host.querySelectorAll('.katex-host')).toHaveLength(0)
    }

    // Prose, tables, code fences and the alert callout still render.
    expect(screen.getByText(/Randles circuit is used to model EIS data/)).toBeInTheDocument()
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.textContent).toContain('Warburg Impedance')
  })
})
