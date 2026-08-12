import { describe, expect, it } from 'vitest'

// Static-analysis guard, same category as `no-native-title.test.ts`: a BUTTON
// that reveals itself on hover must also be visible to a finger.
//
// `opacity-0 … group-hover/x:opacity-100` is the house pattern for chrome that
// only appears under the cursor. It has one property that keeps biting: opacity
// hides a control but does NOT stop it taking taps. So on a coarse pointer,
// where `:hover` never resolves, the button does not disappear — it becomes an
// INVISIBLE control the user can still hit by accident and can never find on
// purpose. Every such button therefore needs a companion that unhides it on
// touch: `coarse:opacity-100` (or the inverse spelling, `fine:opacity-0` +
// visible base), exactly as ~30 buttons in this app already carry.
//
// This has regressed repeatedly — a saved layout preset that could not be
// deleted with a finger (MJXHRM-374), and a zone strip whose "new tab" `+` and
// minimize chevron were invisible-but-tappable (MJXHRM-402). Both were found by
// hand, one surface at a time. The rule is mechanical, so it is checked
// mechanically now.
//
// Scoped to `<button>` / `<Button>` on purpose. Hover-revealed SPANS and DIVS
// are overwhelmingly decorative — disclosure carets on headers that are already
// fully clickable, resize-sash highlights, "scroll for more" hints — and
// forcing them visible on touch would be noise, not access. A control the user
// has to press is the thing that must be reachable.

// Every .tsx under src/, as raw source text. `import.meta.glob` rather than
// node:fs — the app's tsconfig is browser-only (no @types/node), and Vite
// resolves this at transform time so it works under jsdom.
const SOURCES = import.meta.glob('/src/**/*.tsx', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>

/**
 * The attribute text of the opening tag starting at `start` (just past the tag
 * name). Walks the tag tracking brace depth and string/template literals rather
 * than scanning to the first `>`, because an inline handler like
 * `onClick={() => …}` supplies a `>` long before the tag ends. Comments are
 * skipped, not scanned: an apostrophe in prose would otherwise open a string
 * literal and swallow the rest of the file.
 */
function openingTagAttrs(content: string, start: number): string {
  let depth = 0
  let quote: null | string = null

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

/** `opacity-0` paired with a hover reveal — with or without a `group/name`
 *  scope, and allowing a variant stack in front (`md:group-hover/x:…`). */
const HOVER_REVEALED = /\bopacity-0\b/u
const HOVER_REVEAL = /(?:^|[\s"'`])(?:[\w-]+:)*(?:group-)?hover(?:\/[\w-]+)?:opacity-100/u

/** Either spelling of the touch companion: force it visible on coarse pointers,
 *  or gate the hiding itself to fine ones. Any non-zero coarse opacity counts —
 *  a row that settles at 80% on touch is reachable; only `coarse:opacity-0`
 *  would not be. */
const TOUCH_COMPANION = /\bcoarse:opacity-(?!0\b)\d+\b|\bfine:opacity-0\b/u

describe('hover-revealed buttons stay reachable on touch', () => {
  it('every hover-revealed <button> carries a coarse-pointer companion', () => {
    const violations: string[] = []

    expect(Object.keys(SOURCES).length).toBeGreaterThan(0)

    for (const [globPath, content] of Object.entries(SOURCES)) {
      const relativePath = globPath.replace(/^\//, '')
      const tagPattern = /<(Button|button)\b/gu
      let match: RegExpExecArray | null

      while ((match = tagPattern.exec(content)) !== null) {
        const attrs = openingTagAttrs(content, match.index + match[0].length)

        if (HOVER_REVEALED.test(attrs) && HOVER_REVEAL.test(attrs) && !TOUCH_COMPANION.test(attrs)) {
          const lineNum = content.slice(0, match.index).split('\n').length

          violations.push(
            `${relativePath}:${lineNum} <${match[1]}> is hover-revealed with no touch companion — add coarse:opacity-100`
          )
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })
})
