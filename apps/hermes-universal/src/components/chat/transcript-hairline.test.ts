/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The transcript's hairline contract, asserted as source text.
//
// Every bordered surface inside the thread — tables, fences, blockquotes,
// callouts, media cards, attachments — paints `--ui-stroke-tertiary`, the
// in-panel hairline. NOT `border-border`: that resolves to `--dt-border`
// (`--ui-stroke-secondary`), the app-wide default, which is a rung hotter and
// made a markdown table glare next to the tool block beside it. The opacity
// dilutions that grew around it (`/40 /45 /50 /55 /60 /70`) were six ad-hoc
// spellings of one colour, so retuning the hairline meant six edits.
//
// This is a source scan, not a behaviour test — the same category as an ESLint
// rule, expressed as a vitest so it runs with the suite. It is here rather than
// in a render test because the failure is a class name nobody looks at, in
// files that mostly have no test of their own, and because jsdom computes no
// paint: what it can prove is the invariant that decides the paint.
//
// ONE exception, and it is not a hairline in the transcript's sense:
// `border-border/65` is the composer's floating-pill edge (`composer-dock.ts`,
// and the "show earlier" pill in `thread/list.tsx` that shares its fill). That
// pill treatment is chrome floating OVER the thread, it is shared verbatim with
// desktop, and desktop kept it when it moved the transcript onto one token.
const PILL_HAIRLINE = 'border-border/65'

// Every module under the two transcript roots, as raw source text.
// `import.meta.glob` rather than node:fs for the sources — the app's tsconfig is
// browser-only (no @types/node for a glob walk), and Vite resolves this at
// transform time so it works under jsdom. Rooted at the project root so keys
// read the same: '/src/components/chat/compact-markdown.tsx'.
const SOURCES = import.meta.glob('/src/components/{assistant-ui,chat}/**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>

// The stylesheet is read off disk: Vitest stubs EVERY css import to an empty
// string (`test.css` is off), `?raw` included, because Vite classifies the
// request by extension before the query. The `/// <reference types="node" />`
// above is what keeps the browser-only tsconfig happy about that.
const STYLESHEET = readFileSync(join(__dirname, '..', '..', 'styles.css'), 'utf8')

/**
 * Every `border-border` / `divide-border` spelling in `source` that is not the
 * composer pill's, as `line:match`.
 *
 * Reported rather than counted so a failure names the file and line to fix.
 */
export function findAdHocHairlines(source: string): string[] {
  const found: string[] = []
  // The trailing lookahead, not `\b`: `\b` is satisfied by the `-` in
  // `border-border-something`, which would report a utility that has nothing to
  // do with the app default.
  const pattern = /\b(?:border|divide)-border(?:\/\d+)?(?![\w-])/gu
  let match: RegExpExecArray | null

  while ((match = pattern.exec(source)) !== null) {
    if (match[0] === PILL_HAIRLINE) {
      continue
    }

    found.push(`${source.slice(0, match.index).split('\n').length}:${match[0]}`)
  }

  return found
}

describe('findAdHocHairlines', () => {
  // The scan is only worth anything if it can see a violation, so prove that
  // against text that DISAGREES with the expected outcome before trusting it
  // against the tree.
  it('flags every dilution of border-border, and spares the composer pill', () => {
    const sample = [
      `const table = 'rounded-md border border-border'`,
      `const fence = 'border border-border/45'`,
      `const rule = 'my-2 border-border/50'`,
      `const rows = '[&_tr]:border-b [&_tr]:border-border/60'`,
      `const quote = 'border-l-2 border-border/70'`,
      `const pill = 'rounded-full border border-border/65 bg-(--composer-fill)'`,
      `const ok = 'border border-(--ui-stroke-tertiary)'`
    ].join('\n')

    expect(findAdHocHairlines(sample)).toEqual([
      '1:border-border',
      '2:border-border/45',
      '3:border-border/50',
      '4:border-border/60',
      '5:border-border/70'
    ])
  })

  it('does not mistake an unrelated border utility for the app default', () => {
    expect(findAdHocHairlines(`'border-border-something border-(--ui-stroke-tertiary) border-transparent'`)).toEqual([])
  })
})

describe('transcript hairlines', () => {
  it('scans the transcript roots', () => {
    // A glob that silently matched nothing would make every assertion below
    // pass without reading a line of the app.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20)
    expect(Object.keys(SOURCES)).toContain('/src/components/assistant-ui/markdown-text.tsx')
    expect(Object.keys(SOURCES)).toContain('/src/components/chat/compact-markdown.tsx')
  })

  it('paints every bordered surface in the thread with --ui-stroke-tertiary', () => {
    const violations: string[] = []

    for (const [globPath, content] of Object.entries(SOURCES)) {
      if (globPath.includes('.test.')) {
        continue
      }

      const relativePath = globPath.replace(/^\//u, '')

      for (const hit of findAdHocHairlines(content)) {
        violations.push(`${relativePath}:${hit} — use border-(--ui-stroke-tertiary)`)
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('keeps the markdown table head on the same token as the table it heads', () => {
    // The `<thead>` separator is the one transcript hairline that cannot live on
    // the element: react-markdown owns the tag, so styles.css overrides it. It
    // was the last `--dt-border` left in the thread, and the reason a table's
    // outer border and its head rule could disagree.
    const rule = /\.aui-md-table thead \{[^}]*\}/u.exec(STYLESHEET)?.[0]

    expect(rule).toBeDefined()
    expect(rule).toContain('var(--ui-stroke-tertiary)')
    expect(rule).not.toContain('var(--dt-border)')
  })
})
