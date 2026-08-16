// Ported from desktop `src/lib/speech-text.ts` (MJXHRM-369), tests included.
// Markup that reads fine on screen is noise out loud: asterisks, hashes,
// backticks and a bare URL get voiced character by character, and a markdown
// table is unlistenable however it is punctuated.
//
// The rules are the accumulated result of hearing the output, not something
// anyone would derive twice from first principles, so they are kept as desktop
// wrote them — with ONE correction (MJXHRM-369 follow-up): desktop flattened the
// line breaks first and then ran its `/^…/gm` heading and list rules, which by
// then had no line starts left to anchor to. Those two rules matched offset 0
// and nothing else, so every list item after the first kept its "- " and was
// voiced. They now run before the flattening, alongside the thematic-break and
// ordered-marker rules the gateway's own cleaner already had.
//
// Applied at the playback seam (`lib/voice-playback.ts`) to whatever the caller
// hands it — a whole message for read-aloud, one chunk of a streaming reply for
// the voice-conversation loop. `lib/speech-chunker.ts` is what guarantees a
// chunk is never half a block; the line-anchored rules below depend on it.

const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|[\u{FE0F}\u{200D}]|[\u{E0020}-\u{E007F}])+/gu

const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g
const CODE_BLOCK_SUMMARY = ' code block omitted '
const INLINE_CODE_RE = /`([^`]+)`/g
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const PARAGRAPH_BREAK_RE = /[ \t]*\n{2,}[ \t]*/g
const PUNCTUATED_PARAGRAPH_BREAK_RE = /([.!?])([*_~`>"'’”)}\]]*)[ \t]*\n{2,}[ \t]*/g
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g

const THINKING_PREFIX_RE =
  /^\s*(?:\([^)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\.\s*/i

const URL_RE = /\bhttps?:\/\/\S+/gi

// Line-anchored markers. These MUST run while the text still has its line
// breaks: `normalizeLineBreaks` flattens the whole string to one line, after
// which `^` under /m only ever matches offset 0. Ordered markers are stripped
// too (the gateway's own cleaner does, tools/tts_text_normalize.py) — "1." at a
// line start is otherwise both spoken and read by the chunker as a complete
// sentence, so a numbered list is voiced as a stream of one-word clips.
const HEADING_MARKER_RE = /^[ \t]{0,3}#{1,6}[ \t]+/gm
const LIST_MARKER_RE = /^[ \t]*(?:[-+*]|\d{1,3}[.)])[ \t]+/gm
const THEMATIC_BREAK_RE = /^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm

const MARKDOWN_TABLE_DELIMITER_CELL_RE = /^:?-{3,}:?$/

interface MarkdownTableRow {
  blockquoteDepth: number
  cells: string[]
}

function isUnescapedPipe(row: string, index: number): boolean {
  let backslashes = 0

  for (let cursor = index - 1; cursor >= 0 && row[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }

  return backslashes % 2 === 0
}

function splitMarkdownTableCells(row: string): string[] {
  const cells: string[] = []
  let cellStart = 0

  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === '|' && isUnescapedPipe(row, index)) {
      cells.push(row.slice(cellStart, index).trim())
      cellStart = index + 1
    }
  }

  cells.push(row.slice(cellStart).trim())

  return cells
}

function parseMarkdownTableRow(line: string): MarkdownTableRow | null {
  let row = line
  let blockquoteDepth = 0

  while (true) {
    const indentation = row.match(/^[ \t]*/)?.[0] ?? ''

    if (indentation.includes('\t') || indentation.length > 3) {
      return null
    }

    row = row.slice(indentation.length)

    if (!row.startsWith('>')) {
      break
    }

    blockquoteDepth += 1
    row = row.slice(1)

    if (row.startsWith(' ')) {
      row = row.slice(1)
    }
  }

  row = row.trimEnd()

  const pipeIndexes = [...row.matchAll(/\|/g)].map(match => match.index).filter(index => isUnescapedPipe(row, index))

  if (pipeIndexes.length === 0) {
    return null
  }

  const hasLeadingPipe = pipeIndexes[0] === 0
  const hasTrailingPipe = pipeIndexes.at(-1) === row.length - 1

  if (hasLeadingPipe) {
    row = row.slice(1)
  }

  if (hasTrailingPipe) {
    row = row.slice(0, -1)
  }

  const cells = splitMarkdownTableCells(row)

  if (cells.length < 2 && !(hasLeadingPipe && hasTrailingPipe && cells.length === 1)) {
    return null
  }

  return { blockquoteDepth, cells }
}

function stripMarkdownTables(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const tableLines = new Set<number>()

  let index = 1

  while (index < lines.length) {
    const delimiterRow = parseMarkdownTableRow(lines[index])
    const headerRow = parseMarkdownTableRow(lines[index - 1])

    if (
      !delimiterRow ||
      !headerRow ||
      !delimiterRow.cells.every(cell => MARKDOWN_TABLE_DELIMITER_CELL_RE.test(cell)) ||
      headerRow.cells.length !== delimiterRow.cells.length ||
      headerRow.blockquoteDepth !== delimiterRow.blockquoteDepth
    ) {
      index += 1

      continue
    }

    tableLines.add(index - 1)
    tableLines.add(index)

    let rowIndex = index + 1

    for (; rowIndex < lines.length; rowIndex += 1) {
      const bodyRow = parseMarkdownTableRow(lines[rowIndex])

      if (!bodyRow || bodyRow.blockquoteDepth !== delimiterRow.blockquoteDepth) {
        break
      }

      tableLines.add(rowIndex)
    }

    index = rowIndex
  }

  return lines.filter((_, index) => !tableLines.has(index)).join('\n')
}

function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{L})-\n(\p{L})/gu, '$1$2')
    .replace(PUNCTUATED_PARAGRAPH_BREAK_RE, '$1$2 ')
    .replace(PARAGRAPH_BREAK_RE, '. ')
    .replace(SOFT_BREAK_RE, ' ')
}

export function sanitizeTextForSpeech(text: string): string {
  // Two passes, and the order between them is the point. Everything anchored to
  // a LINE runs first, on text that still has line breaks; only then are the
  // breaks flattened and the inline rules (links, code spans, URLs, emoji, stray
  // emphasis) applied to the resulting single line.
  const blocks = stripMarkdownTables(text)
    .replace(FENCED_CODE_RE, CODE_BLOCK_SUMMARY)
    .replace(THEMATIC_BREAK_RE, '')
    .replace(HEADING_MARKER_RE, '')
    .replace(LIST_MARKER_RE, '')

  return normalizeLineBreaks(blocks)
    .replace(THINKING_PREFIX_RE, ' ')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(INLINE_CODE_RE, '$1')
    .replace(URL_RE, ' link ')
    .replace(EMOJI_RE, ' ')
    .replace(/[*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
