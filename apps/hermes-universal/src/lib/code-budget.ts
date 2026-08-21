/**
 * How much code is worth syntax-highlighting, and how to slice it up.
 *
 * These numbers used to live in `components/chat/shiki-highlighter.tsx`, which
 * meant the diff renderer and the file-preview pane both imported a chat
 * COMPONENT to get an integer. They are pure arithmetic over a string, so they
 * live here instead: zero imports, no React, safe to reach from anywhere.
 */

// Past these, highlighting stops being an aid and starts being a stall: the
// pass is O(n) but the token spans it produces are not free to lay out, and a
// fence this size is something to skim rather than read. Over budget renders as
// plain text, which is the same thing a fence renders while it streams.
export const MAX_HIGHLIGHT_CHARS = 150_000
export const MAX_HIGHLIGHT_LINES = 3_000

export function exceedsHighlightBudget(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return true
  }

  let lines = 1
  let idx = code.indexOf('\n')

  while (idx !== -1) {
    if ((lines += 1) > MAX_HIGHLIGHT_LINES) {
      return true
    }

    idx = code.indexOf('\n', idx + 1)
  }

  return false
}

export interface CodeChunk {
  text: string
  lines: number
}

/**
 * Split into fixed-line chunks so a caller can hand each one to
 * `content-visibility`. The code fence no longer does this — chunking only ever
 * existed to serve containment, and containment is off on mobile because both
 * mobile webviews drop `contain-intrinsic-size: auto <length>` and collapse the
 * skipped chunk to 0x0. `HugeTextFallback` (markdown-text.tsx) still uses it for
 * a message too big to parse as markdown at all, where the tradeoff is different.
 */
export function chunkByLines(code: string, perChunk: number): CodeChunk[] {
  const lines = code.split('\n')

  if (lines.length <= perChunk) {
    return [{ text: code, lines: lines.length }]
  }

  const chunks: CodeChunk[] = []

  for (let i = 0; i < lines.length; i += perChunk) {
    const slice = lines.slice(i, i + perChunk)
    chunks.push({ text: slice.join('\n'), lines: slice.length })
  }

  return chunks
}
