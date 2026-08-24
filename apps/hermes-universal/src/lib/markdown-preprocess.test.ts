import { describe, expect, it } from 'vitest'

import { escapeCurrencyDollars, preprocessMarkdown, promoteStandaloneDisplayMath } from './markdown-preprocess'

// remark-math only classes `$$…$$` as display math when the delimiters sit on
// their own lines. Models emit the single-line form constantly, so without this
// promotion most standalone equations in a chat rendered as small in-flow math.
describe('promoteStandaloneDisplayMath', () => {
  it('promotes a paragraph that is only $$…$$', () => {
    expect(promoteStandaloneDisplayMath('a\n\n$$x + y$$\n\nb')).toBe('a\n\n$$\nx + y\n$$\n\nb')
  })

  it('promotes when the line is the whole input', () => {
    expect(promoteStandaloneDisplayMath('$$ECSA = \\frac{C_{dl}}{C_s}$$')).toBe('$$\nECSA = \\frac{C_{dl}}{C_s}\n$$')
  })

  it('tolerates up to three leading spaces (markdown paragraph indent)', () => {
    expect(promoteStandaloneDisplayMath('   $$x$$')).toBe('$$\nx\n$$')
  })

  // Everything below must stay untouched — promoting any of these would change
  // the document's structure, not just how one equation is styled.
  it('leaves mid-sentence display math inline', () => {
    const text = 'the identity $$x$$ holds'

    expect(promoteStandaloneDisplayMath(text)).toBe(text)
  })

  it('leaves a $$…$$ line that is part of a paragraph', () => {
    const text = 'given that\n$$x$$\nwe conclude'

    expect(promoteStandaloneDisplayMath(text)).toBe(text)
  })

  it('leaves list items and blockquotes alone', () => {
    expect(promoteStandaloneDisplayMath('- $$x$$')).toBe('- $$x$$')
    expect(promoteStandaloneDisplayMath('> $$x$$')).toBe('> $$x$$')
  })

  it('leaves an indented code block alone', () => {
    expect(promoteStandaloneDisplayMath('    $$x$$')).toBe('    $$x$$')
  })

  it('leaves a line holding more than one expression', () => {
    expect(promoteStandaloneDisplayMath('$$x$$ $$y$$')).toBe('$$x$$ $$y$$')
    expect(promoteStandaloneDisplayMath('$$$$')).toBe('$$$$')
  })

  it('leaves the already-correct multi-line form untouched', () => {
    const text = '$$\nx\n$$'

    expect(promoteStandaloneDisplayMath(text)).toBe(text)
  })
})

// Upstream escapes EVERY `$` before a digit, which mangles math that happens to
// open with one — a table row of `$5$–$50\,\Omega$` rendered as literal text.
describe('escapeCurrencyDollars', () => {
  it('still escapes prices', () => {
    expect(escapeCurrencyDollars('it costs $5 and $10.')).toBe('it costs \\$5 and \\$10.')
    expect(escapeCurrencyDollars('$1,299 total')).toBe('\\$1,299 total')
    expect(escapeCurrencyDollars('from $5 to $10')).toBe('from \\$5 to \\$10')
  })

  it('does not pair two prices in one sentence into fake math', () => {
    // Body `5 + ` has whitespace and no TeX-only character, so it reads as prose.
    expect(escapeCurrencyDollars('$5 + $10 = $15')).toBe('\\$5 + \\$10 = \\$15')
  })

  it('preserves digit-leading math that closes with no whitespace', () => {
    expect(escapeCurrencyDollars('$5$')).toBe('$5$')
    expect(escapeCurrencyDollars('range $0.8$–$1.0$')).toBe('range $0.8$–$1.0$')
    expect(escapeCurrencyDollars('$10^2$')).toBe('$10^2$')
  })

  it('preserves digit-leading math containing TeX commands', () => {
    expect(escapeCurrencyDollars('$50\\,\\Omega$')).toBe('$50\\,\\Omega$')
    expect(escapeCurrencyDollars('$10^3\\,\\mu\\mathrm{F}$')).toBe('$10^3\\,\\mu\\mathrm{F}$')
  })

  it('leaves display math and already-escaped dollars alone', () => {
    expect(escapeCurrencyDollars('$$5x$$')).toBe('$$5x$$')
    expect(escapeCurrencyDollars('already \\$5')).toBe('already \\$5')
  })

  it('does not pair across a line break', () => {
    expect(escapeCurrencyDollars('costs $5\nand $6')).toBe('costs \\$5\nand \\$6')
  })
})

// The two fixes have to survive the full pipeline, not just their own unit.
describe('preprocessMarkdown', () => {
  it('promotes a standalone equation end to end', () => {
    expect(preprocessMarkdown('Given:\n\n$$ECSA = \\frac{C_{dl}}{C_s}$$\n\nSo.')).toContain(
      '$$\nECSA = \\frac{C_{dl}}{C_s}\n$$'
    )
  })

  it('keeps a table row of digit-leading math intact', () => {
    const row = '| $R_s$ | $5$–$50\\,\\Omega$ |'

    expect(preprocessMarkdown(row)).toBe(row)
  })

  it('still escapes prices in prose', () => {
    expect(preprocessMarkdown('The plan costs $20 per month.')).toContain('\\$20')
  })

  it('does not touch dollars inside a fenced code block', () => {
    const fence = '```bash\necho $5\n```'

    expect(preprocessMarkdown(fence)).toContain('echo $5')
  })
})

/**
 * File links the agent wrote by hand, rather than as a `MEDIA:` marker.
 *
 * Both shapes were dead before this pass. A `file:` href is DELETED outright by
 * streamdown's `rehype-sanitize` (its GitHub schema allows http/https/irc/ircs/
 * mailto/xmpp for `href`), so `MarkdownLink` received `href === undefined` and
 * rendered inert text. A bare path survived sanitize but fell through to
 * `openExternalLink`, which asks THIS device's OS to open a path that only
 * exists on the gateway. Rewriting to the `#media:` fragment dodges both: a
 * fragment has no protocol for sanitize to reject.
 */
describe('preprocessMarkdown file links', () => {
  it('routes a bare absolute path through the media scheme', () => {
    expect(preprocessMarkdown('[Q3 report](/work/out/q3.pdf)')).toBe('[Q3 report](#media:%2Fwork%2Fout%2Fq3.pdf)')
  })

  it('routes a file: URL through it too, unwrapping the path first', () => {
    expect(preprocessMarkdown('[notes](file:///work/notes.txt)')).toBe('[notes](#media:%2Fwork%2Fnotes.txt)')
  })

  it('keeps the label the agent wrote — it is the only copy of that wording', () => {
    expect(preprocessMarkdown('see [the full audit](/srv/audit.csv) for detail')).toContain('[the full audit](')
  })

  it('leaves an image as a bare path, which MarkdownImage resolves itself', () => {
    expect(preprocessMarkdown('![chart](file:///work/chart.png)')).toBe('![chart](/work/chart.png)')
  })

  it('does not touch http(s) links', () => {
    expect(preprocessMarkdown('[docs](https://example.com/a.pdf)')).toBe('[docs](https://example.com/a.pdf)')
  })

  // `[docs](/guide)` is a route, not a file. Without the extension test this
  // pass would claim it and turn a working link into a download attempt.
  it('does not claim an extensionless absolute target', () => {
    expect(preprocessMarkdown('[docs](/guide)')).toBe('[docs](/guide)')
  })

  it('leaves a path inside a fenced block literal', () => {
    const fenced = '```\n[report](/work/out/q3.pdf)\n```'

    expect(preprocessMarkdown(fenced)).toContain('[report](/work/out/q3.pdf)')
  })

  it('leaves a path inside an inline code span literal', () => {
    expect(preprocessMarkdown('`[report](/work/q3.pdf)`')).toBe('`[report](/work/q3.pdf)`')
  })

  // `renderMediaTags` has already produced these upstream; a second pass must
  // not double-encode them.
  it('is idempotent on an existing #media: link', () => {
    const already = '[File: q3.pdf](#media:%2Fwork%2Fq3.pdf)'

    expect(preprocessMarkdown(already)).toBe(already)
  })
})

/**
 * `MEDIA:/path` and `[label](/path)` are two spellings of "here is a file", so
 * they converge on one href through one function (`renderFileRefs`).
 *
 * Running that at RENDER rather than only at ingest is what makes it
 * retroactive: an old transcript is normalized as it is drawn, so chats that
 * predate this work do not need re-ingesting or rewriting on the gateway. It is
 * also a safety net — the ingest pass is guarded on a literal `MEDIA:` at both
 * call sites (so it cannot reflow plain prose), which means text arriving by
 * any other route would otherwise never be normalized at all.
 */
describe('preprocessMarkdown unifies both file conventions', () => {
  it('normalizes a MEDIA: marker that never went through ingest', () => {
    expect(preprocessMarkdown('MEDIA:/tmp/demo.mp4')).toBe('[Video: demo.mp4](#media:%2Ftmp%2Fdemo.mp4)')
  })

  it('lands both spellings of the same file on the same href', () => {
    const fromMarker = preprocessMarkdown('MEDIA:/work/q3.pdf')
    const fromLink = preprocessMarkdown('[q3.pdf](/work/q3.pdf)')
    const href = (out: string) => out.slice(out.indexOf('](') + 2, out.length - 1)

    expect(href(fromMarker)).toBe(href(fromLink))
  })

  it('handles a message that mixes the two', () => {
    const out = preprocessMarkdown('MEDIA:/tmp/clip.mp3\n\nand [the notes](/work/notes.txt) too')

    expect(out).toContain('(#media:%2Ftmp%2Fclip.mp3)')
    expect(out).toContain('[the notes](#media:%2Fwork%2Fnotes.txt)')
  })

  it('leaves a MEDIA: marker inside a fence literal, which ingest cannot do', () => {
    expect(preprocessMarkdown('```\nMEDIA:/tmp/demo.mp4\n```')).toContain('MEDIA:/tmp/demo.mp4')
  })
})
