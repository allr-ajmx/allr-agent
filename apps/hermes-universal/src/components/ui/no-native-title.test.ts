import { describe, expect, it } from 'vitest'

// Static-analysis guard, ported from desktop's no-native-title.test.ts: no
// <button> or <Button> in the renderer may use the native HTML `title=`
// attribute. Native tooltips are unstyled, delayed (~500ms OS default), and
// visually inconsistent with the themed `Tip`. Use `<Tip label={...}>` instead
// — and `<Tip label={<TipKeybindLabel actionId="…" />}>` when the button is
// bound to a rebindable shortcut, so the tip carries the live combo.
//
// This is a source-text scan, not a behavior test — the same category as an
// ESLint rule, expressed as a vitest so it runs with the rest of the suite.

// Every .tsx under src/, as raw source text. `import.meta.glob` rather than
// node:fs — the app's tsconfig is browser-only (no @types/node), and Vite
// resolves this at transform time so it works under jsdom.
// Rooted at the project root (not relative to this file) so every key reads the
// same: '/src/app/shell/titlebar.tsx'.
const SOURCES = import.meta.glob('/src/**/*.tsx', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>

/**
 * The attribute text of the opening tag starting at `start` (the `<`).
 *
 * A plain `[^>]*?` scan stops at the first `>`, which an inline handler like
 * `onClick={() => …}` supplies long before the tag actually ends — that hole
 * hides real violations. So walk the tag instead, tracking brace depth and
 * string/template literals, and end only at a `>` that sits at depth 0.
 *
 * Comments must be skipped, not scanned: an apostrophe in prose ("can't") would
 * otherwise open a string literal and swallow the rest of the file.
 */
function openingTagAttrs(content: string, start: number): string {
  let depth = 0
  let quote: string | null = null

  for (let i = start; i < content.length; i++) {
    const char = content[i]

    if (quote) {
      if (char === '\\') {
        i++
      } else if (char === quote) {
        quote = null
      }

      continue
    }

    if (char === '/' && content[i + 1] === '/') {
      const lineEnd = content.indexOf('\n', i)

      if (lineEnd === -1) {
        break
      }

      i = lineEnd

      continue
    }

    if (char === '/' && content[i + 1] === '*') {
      const blockEnd = content.indexOf('*/', i + 2)

      if (blockEnd === -1) {
        break
      }

      i = blockEnd + 1

      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
    } else if (char === '>' && depth === 0) {
      return content.slice(start, i)
    }
  }

  return content.slice(start)
}

describe('no native title= on button elements', () => {
  it('uses <Tip> instead of native title= on all button elements', () => {
    const violations: string[] = []

    expect(Object.keys(SOURCES).length).toBeGreaterThan(0)

    for (const [globPath, content] of Object.entries(SOURCES)) {
      // '/src/app/shell/titlebar.tsx' → 'src/app/shell/titlebar.tsx'
      const relativePath = globPath.replace(/^\//, '')

      const tagPattern = /<(Button|button)\b/gu
      let match: RegExpExecArray | null

      while ((match = tagPattern.exec(content)) !== null) {
        const tagName = match[1]
        const attrs = openingTagAttrs(content, match.index + match[0].length)

        if (/\btitle=/.test(attrs)) {
          const lineNum = content.slice(0, match.index).split('\n').length

          violations.push(`${relativePath}:${lineNum} <${tagName}> has title= — use <Tip>`)
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })
})
