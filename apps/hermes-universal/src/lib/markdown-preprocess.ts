import { normalizeMathDelimiters } from '@assistant-ui/react-streamdown'

import { isLikelyProseFence, sanitizeLanguageTag } from '@/lib/markdown-code'
import { stripPreviewTargets } from '@/lib/preview-targets'
import { linkifySessionRefs } from '@/lib/session-refs'

const REASONING_BLOCK_RE = /<(think|thinking|reasoning|scratchpad|analysis)>[\s\S]*?<\/\1>\s*/gi
const PREVIEW_MARKER_RE = /\[Preview:[^\]]+\]\(#preview[:/][^)]+\)/gi

const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/
const EMPTY_FENCE_BLOCK_RE = /(^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\n|$)/g
const CODE_FENCE_SPLIT_RE = /((?:```|~~~)[\s\S]*?(?:```|~~~))/g
const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g
// Bare-URL autolink matcher. The character classes EXCLUDE `*` so a URL that
// abuts markdown emphasis with no separating space (e.g. `**label: https://x**`,
// a very common LLM pattern) doesn't swallow the trailing `**` into the href.
// `*` is never meaningful in a real URL path, and GFM's own autolink extension
// likewise strips trailing emphasis/punctuation — so dropping it here is safe
// and keeps the emphasis run intact. Other trailing punctuation is still peeled
// off by the final `[^\s<>"'`*.,;:!?]` class.
const RAW_URL_RE = /https?:\/\/[^\s<>"'`*]+[^\s<>"'`*.,;:!?]/g
const LOCAL_PREVIEW_URL_RE = /(^|\s)https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\/?[^\s<>"'`]*/gi
const LOCAL_PREVIEW_ONLY_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\/?$/i
const URL_ONLY_LINE_RE = /^\s*https?:\/\/\S+\s*$/i
const CITATION_MARKER_RE = /(?<=[\p{L}\p{N})\].,!?:;"'”’])\[(?:\d+(?:\s*,\s*\d+)*)\](?!\()/gu

/**
 * Returns true when `body` contains a line that's exactly `marker` (modulo
 * leading/trailing horizontal whitespace) — i.e. an unambiguous close fence
 * for an opening fence with the same marker.
 *
 * Implemented with string comparisons (not RegExp) so that input-derived
 * `marker` values can never bleed into a regex pattern.
 */
function hasCloseFenceLine(body: string, marker: string): boolean {
  const lines = body.split('\n')

  // Original regex required `\n` immediately before the close fence, so the
  // first line of `body` (which has no preceding newline within `body`)
  // cannot itself be the close fence.
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]
    let lo = 0
    let hi = line.length

    while (lo < hi && (line[lo] === ' ' || line[lo] === '\t')) {
      lo += 1
    }

    while (hi > lo && (line[hi - 1] === ' ' || line[hi - 1] === '\t')) {
      hi -= 1
    }

    if (line.slice(lo, hi) === marker) {
      return true
    }
  }

  return false
}

function scrubBacktickNoise(text: string): string {
  const balancedFenceRe = /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g
  const protectedRanges: { end: number; start: number }[] = []
  let match: RegExpExecArray | null

  while ((match = balancedFenceRe.exec(text)) !== null) {
    const start = match.index + match[1].length

    protectedRanges.push({ end: balancedFenceRe.lastIndex, start })
  }

  const danglingCodeFenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})([a-z0-9][a-z0-9+#-]{0,15})[ \t]*\n([\s\S]*)$/gi

  while ((match = danglingCodeFenceRe.exec(text)) !== null) {
    const start = match.index + match[1].length
    const marker = match[2] || '```'
    const info = match[3] || ''
    const body = match[4] || ''

    if (!hasCloseFenceLine(body, marker) && sanitizeLanguageTag(info) && !isLikelyProseFence(info, body)) {
      protectedRanges.push({ end: text.length, start })

      break
    }
  }

  protectedRanges.sort((a, b) => a.start - b.start)

  const fenceNoiseRe = /`{3,}/g
  let out = ''
  let cursor = 0

  for (const range of protectedRanges) {
    out += text.slice(cursor, range.start).replace(fenceNoiseRe, '')
    out += text.slice(range.start, range.end)
    cursor = range.end
  }

  out += text.slice(cursor).replace(fenceNoiseRe, '')

  for (let pass = 0; pass < 2; pass += 1) {
    // Match EXACTLY 2 backticks (not part of a longer run) on each side.
    out = out.replace(/(?<!`)``(?!`)\s*(?<!`)``(?!`)/g, '')
    out = out.replace(/(^|[^`])``(?=\s|[.,;:!?)\]'"—–-]|$)/g, '$1')
  }

  return out
}

function stripEmptyFenceBlocks(text: string): string {
  return text.replace(EMPTY_FENCE_BLOCK_RE, '$1')
}

function isUrlOnlyBlock(lines: string[]): boolean {
  const nonEmpty = lines.filter(line => line.trim())

  return nonEmpty.length > 0 && nonEmpty.every(line => URL_ONLY_LINE_RE.test(line))
}

function autoLinkRawUrls(text: string): string {
  return text.replace(RAW_URL_RE, (url: string, index: number) => {
    const previous = text[index - 1] || ''
    const beforePrevious = text[index - 2] || ''

    if (previous === '<' || (beforePrevious === ']' && previous === '(')) {
      return url
    }

    return `<${url}>`
  })
}

function normalizeVisibleProse(text: string): string {
  return text
    .split(INLINE_CODE_SPLIT_RE)
    .map(part =>
      part.startsWith('`')
        ? part
        : // `linkifySessionRefs` LAST: an `@session:` ref the agent wrote is
          // prose, not a URL, so it is rewritten after the autolinker has had
          // its pass — and only OUTSIDE code spans, because a ref quoted in
          // backticks is being talked about rather than linked to.
          linkifySessionRefs(
            autoLinkRawUrls(
              part.replace(/`{3,}/g, '').replace(LOCAL_PREVIEW_URL_RE, '$1').replace(CITATION_MARKER_RE, '')
            )
          )
    )
    .join('')
}

function extend(out: string[], lines: string[]) {
  for (const line of lines) {
    out.push(line)
  }
}

function pushProseFence(out: string[], indent: string, info: string, lines: string[]) {
  if (info) {
    out.push(`${indent}${info}`.trimEnd())
  }

  extend(out, lines)
}

function findClosingFence(lines: string[], start: number, marker: string): number {
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const closeMatch = (lines[cursor] || '').match(FENCE_LINE_RE)

    if (!closeMatch) {
      continue
    }

    const closeMarker = closeMatch[2] || ''
    const closeInfo = (closeMatch[3] || '').trim()

    if (!closeInfo && closeMarker[0] === marker[0] && closeMarker.length >= marker.length) {
      return cursor
    }
  }

  return -1
}

// Languages that should be routed to the math (KaTeX) renderer instead of
// being shown as a syntax-highlighted code block. Only `math` (not `latex`/
// `tex`) — GitHub markup uses ```math for "render" and ```latex for "source".
const MATH_FENCE_LANGUAGES = new Set(['math'])

// A `$` that opens a currency amount (`$5`, `$19.99`, `$1,299`). Same shape as
// streamdown's `escapeCurrencyDollars`: an even run of backslashes before it
// (so an already-escaped `\$` is left alone), and a digit after.
const CURRENCY_DOLLAR_RE = /(^|[^\\$])((?:\\\\)*)\$(?=\d)/g

// Characters that only appear in TeX, never in prose arithmetic. Used to tell
// `$10^2$` (math) from `$5 + $10` (two prices). Deliberately EXCLUDES `+`, `-`
// and `=`, which show up constantly in sentences about money.
const TEX_ONLY_RE = /[\\^_{}]/

// How far ahead to look for a closing `$`. Long enough for a real inline
// equation, short enough that two prices in one sentence don't pair up.
const INLINE_MATH_LOOKAHEAD = 60

/**
 * Escapes a `$` that opens a currency amount, so remark-math's single-dollar
 * mode doesn't eat prices as math delimiters.
 *
 * Replaces streamdown's `escapeCurrencyDollars`, which escapes EVERY `$` before
 * a digit and so mangles perfectly good math that happens to start with one.
 * That is not hypothetical: a table row of `$5$–$50\,\Omega$` rendered as
 * literal text, because the leading `$5` looked like a price.
 *
 * The extra signal used here is the closing delimiter. A `$` before a digit is
 * treated as MATH (left unescaped) when a closing `$` follows on the same line
 * within a short window AND the enclosed body looks like TeX rather than prose:
 *
 *   - no whitespace at all (`$5$`, `$0.8$`, `$10^2$`), or
 *   - a character that only occurs in TeX (`$50\,\Omega$`, `$10^3\,\mu F$`)
 *
 * Everything else is currency and gets escaped. So `$5 + $10 = $15` still
 * escapes (the body `5 + ` has whitespace and no TeX character), and so does
 * `costs $5 to $10`. The residual false-negative is an expression that both
 * opens with a digit and contains spaces but no TeX, e.g. `$5x = 10$` — that
 * was already broken by the upstream version, so this is strictly an
 * improvement, not a new trade-off.
 */
export function escapeCurrencyDollars(text: string): string {
  return text.replace(CURRENCY_DOLLAR_RE, (match, before: string, slashes: string, offset: number) => {
    // Index of the `$` itself: after the leading context and backslash run.
    const dollar = offset + before.length + slashes.length
    const lineEnd = text.indexOf('\n', dollar)
    const limit = Math.min(lineEnd === -1 ? text.length : lineEnd, dollar + 1 + INLINE_MATH_LOOKAHEAD)
    const close = text.indexOf('$', dollar + 1)

    if (close !== -1 && close < limit) {
      const body = text.slice(dollar + 1, close)

      if (!/\s/.test(body) || TEX_ONLY_RE.test(body)) {
        return match
      }
    }

    return `${before}${slashes}\\$`
  })
}

// A line that is nothing but `$$…$$`. Up to three leading spaces is markdown's
// paragraph indent allowance; four or more would be an indented code block, and
// a list/quote marker (`-`, `>`) means the line isn't a bare paragraph, so
// neither can match here.
const STANDALONE_DISPLAY_MATH_RE = /^[ \t]{0,3}\$\$(.+)\$\$[ \t]*$/

/**
 * Rewrites a paragraph consisting solely of `$$…$$` into the multi-line form.
 *
 * remark-math only emits `math-display` when the `$$` delimiters sit on their
 * OWN lines; a single-line `$$x$$` is classed `math-inline` and renders as small
 * in-flow math instead of a centred block. (Stock rehype-katex branches on the
 * same classes, so this isn't specific to our renderer.) Models emit the
 * single-line form constantly — it's what a standalone equation almost always
 * looks like in an LLM answer — so without this, most display math in a chat
 * didn't render as display math.
 *
 * Conservative on purpose. The line must be its own paragraph: blank (or
 * absent) lines on both sides, and no other `$$` inside the body. That leaves
 * mid-sentence `$$x$$` inline, where promoting it would wrongly split the
 * paragraph.
 */
export function promoteStandaloneDisplayMath(text: string): string {
  if (!text.includes('$$')) {
    return text
  }

  const lines = text.split('\n')
  let changed = false

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(STANDALONE_DISPLAY_MATH_RE)

    if (!match) {
      continue
    }

    const body = match[1].trim()

    // A body containing `$$` means the line holds more than one expression (or
    // an empty `$$$$`), which this rewrite has no safe reading of.
    if (!body || body.includes('$$')) {
      continue
    }

    // Its own paragraph: nothing but blank lines adjacent. A segment edge counts
    // as blank — segments are split at fence boundaries, so the edge is a break.
    const isolated = (i === 0 || !lines[i - 1].trim()) && (i === lines.length - 1 || !lines[i + 1].trim())

    if (!isolated) {
      continue
    }

    lines[i] = `$$\n${body}\n$$`
    changed = true
  }

  return changed ? lines.join('\n') : text
}

function isMathFence(language: string): boolean {
  return MATH_FENCE_LANGUAGES.has(language.toLowerCase())
}

function normalizeFenceBlocks(text: string): string {
  const sourceLines = text.split('\n')
  const out: string[] = []
  let index = 0

  while (index < sourceLines.length) {
    const line = sourceLines[index] || ''
    const match = line.match(FENCE_LINE_RE)

    if (!match) {
      out.push(line)
      index += 1

      continue
    }

    const indent = match[1] || ''
    const marker = match[2] || '```'
    const infoRaw = (match[3] || '').trim()
    const languageToken = infoRaw.split(/\s+/, 1)[0] || ''
    const language = sanitizeLanguageTag(languageToken)
    const openerValid = !infoRaw || Boolean(language)

    if (!openerValid) {
      out.push(`${indent}${infoRaw}`.trimEnd())
      index += 1

      continue
    }

    const closeIndex = findClosingFence(sourceLines, index, marker)
    const bodyLines = sourceLines.slice(index + 1, closeIndex === -1 ? sourceLines.length : closeIndex)
    const body = bodyLines.join('\n')

    if (closeIndex !== -1 && !body.trim()) {
      index = closeIndex + 1

      continue
    }

    if (closeIndex !== -1 && LOCAL_PREVIEW_ONLY_RE.test(body.trim())) {
      index = closeIndex + 1

      continue
    }

    if (closeIndex !== -1 && isUrlOnlyBlock(bodyLines)) {
      extend(out, bodyLines)
      index = closeIndex + 1

      continue
    }

    if (closeIndex === -1) {
      if (!body.trim()) {
        index += 1

        continue
      }

      if (isLikelyProseFence(infoRaw, body)) {
        pushProseFence(out, indent, infoRaw, bodyLines)
      } else if (isMathFence(language)) {
        // Streaming math fence — rewrite the language tag to "math".
        out.push(`${indent}${marker}math`)
        extend(out, bodyLines)
      } else {
        out.push(`${indent}${marker}${language}`)
        extend(out, bodyLines)
      }

      break
    }

    if (isLikelyProseFence(infoRaw, body)) {
      pushProseFence(out, indent, infoRaw, bodyLines)
      index = closeIndex + 1

      continue
    }

    if (isMathFence(language)) {
      // Closed math fence — rewrite the language tag to "math" so rehype-katex's
      // language-math class detection picks it up.
      out.push(`${indent}${marker}math`)
      extend(out, bodyLines)
      out.push(`${indent}${marker}`)
      index = closeIndex + 1

      continue
    }

    out.push(`${indent}${marker}${language}`)
    extend(out, bodyLines)
    out.push(`${indent}${marker}`)
    index = closeIndex + 1
  }

  return out.join('\n')
}

export function preprocessMarkdown(text: string): string {
  const cleaned = text.replace(REASONING_BLOCK_RE, '').replace(PREVIEW_MARKER_RE, '')
  const scrubbed = scrubBacktickNoise(cleaned)
  const normalizedFences = normalizeFenceBlocks(scrubbed)
  const strippedEmptyFences = stripEmptyFenceBlocks(normalizedFences)

  return strippedEmptyFences
    .split(CODE_FENCE_SPLIT_RE)
    .map(part => {
      // Fence blocks pass through untouched.
      if (/^(?:```|~~~)/.test(part)) {
        return part
      }

      // Whitespace-only segments must NOT go through stripPreviewTargets — its
      // internal .trim() would collapse them and glue surrounding fences.
      if (!part.trim()) {
        return part
      }

      // Preserve leading/trailing whitespace around the prose body so
      // fence-prose-fence sequences keep their blank-line gaps.
      const leading = part.match(/^\s*/)?.[0] ?? ''
      const trailing = part.match(/\s*$/)?.[0] ?? ''

      // Run only on prose segments so `$5` literals and `\(` inside code stay.
      // Order matters: promote AFTER normalizeMathDelimiters, so a `\[…\]`
      // display block (already rewritten to `$$…$$` by then) gets promoted too.
      const transformed = normalizeVisibleProse(
        stripPreviewTargets(promoteStandaloneDisplayMath(normalizeMathDelimiters(escapeCurrencyDollars(part))))
      )

      return leading + transformed + trailing
    })
    .join('')
    .replace(/[ \t]+\n/g, '\n')
}
