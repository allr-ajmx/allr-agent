'use client'

import * as React from 'react'
import type { BundledLanguage, ThemedToken } from 'shiki'

import { chunkLines, type LineChunk, useFixedRowWindow } from '@/components/chat/fixed-row-window'
import { SHIKI_THEME } from '@/components/chat/shiki-theme'
import { exceedsHighlightBudget } from '@/lib/code-budget'
import { shikiLanguageForFilename } from '@/lib/markdown-code'
import { cn } from '@/lib/utils'

/**
 * Renders a unified diff for a tool's file edit. Two paths share one parse:
 *  - `TokenizedDiffBody` asks Shiki for TOKENS and renders them into rows this
 *    file owns, tinting each row by its add/remove kind.
 *  - `DiffLines` is the color-only fallback (no language, over budget, or while
 *    the tokens are in flight).
 * Both drop git file-headers + `@@` hunk noise and the `+/-` gutter so changes
 * read by color + a 2px gutter accent, the way Cursor does.
 *
 * There used to be a third: `SyntaxDiff`, which rendered `react-shiki`'s own
 * `<pre>`/`<code>`/`span.line` DOM and painted the tints onto it with a Shiki
 * transformer. That is the library chain ALLR-30 removed from the chat fence
 * and ALLR-40 removed from the file preview — DOM whose tags, classes and
 * inline styles belong to a library, which collapsed a fence to one line on a
 * signed iOS build and left the preview pane empty. It is gone here too, and
 * `react-shiki` with it. `shiki` itself stays: `codeToTokens` returns DATA,
 * behind a dynamic import, and every element around it is ours.
 */
type DiffKind = 'add' | 'context' | 'remove'

export interface DiffLine {
  kind: DiffKind
  text: string
  /** 1-based line number in the old/new file (absent on the "other" side of an
   *  add/remove, and on hunk-separator blanks). Only used when line numbers are
   *  shown (the preview's full diff). */
  newNo?: number
  oldNo?: number
}

interface ParsedHunk {
  lines: Array<{ kind: DiffKind; text: string }>
  newStart: number
  oldStart: number
}

// Tint + 2px gutter accent per change kind. Text color is included for the
// plain renderer; the Shiki path omits it so syntax colors win, layering only
// the background + border.
const DIFF_KIND_TINT: Record<DiffKind, string> = {
  add: 'border-(--ui-green) bg-(--ui-green)/12',
  context: 'border-transparent',
  remove: 'border-(--ui-red) bg-(--ui-red)/12'
}

const DIFF_KIND_TEXT: Record<DiffKind, string> = {
  add: 'text-(--ui-green)',
  context: '',
  remove: 'text-(--ui-red)'
}

// `diff-line` is a hook, not a style: it is the one handle every renderer here
// shares (plain rows, Shiki's transformer output, the windowed rows), so a
// wrapping panel can re-flow all three from a single rule in styles.css instead
// of threading a `wrap` prop through each of them.
const DIFF_LINE_BASE = 'diff-line block min-w-max whitespace-pre border-l-2 px-2.5 py-px'
const PREVIEW_DIFF_LINE_BASE = 'diff-line block h-5 min-w-max whitespace-pre px-2.5 leading-5'
const PREVIEW_CHUNK_LINES = 200
const PREVIEW_LINE_PX = 20
const PREVIEW_OVERSCAN_LINES = 400

// Bleed out of the tool-card body's `p-1.5` so tints/borders run flush to the
// card edges (rounded corners clip via the card's overflow); compact height
// with internal scroll like a code block.
// `overscroll-y-auto` so reaching the box's top/bottom hands the wheel back to
// the page (no scroll-trap); `overscroll-x-contain` keeps a trackpad's sideways
// overscroll on long code lines from firing browser back/forward navigation.
const DIFF_BOX_CLASS =
  '-mx-1.5 -mb-1.5 max-h-[12rem] max-w-none min-w-0 overflow-auto overscroll-x-contain overscroll-y-auto font-mono text-[0.7rem] leading-relaxed text-(--ui-text-secondary)'

function diffKind(line: string): DiffKind {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'add'
  }

  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'remove'
  }

  return 'context'
}

// Drop the leading +/-/space gutter so changes read by color alone, keeping the
// rest of the indentation intact.
function stripDiffMarker(line: string): string {
  if (diffKind(line) !== 'context' || line.startsWith(' ')) {
    return line.slice(1)
  }

  return line
}

// Git-style unified diffs arrive with a file-header preamble — `diff --git`,
// `index …`, `--- a/path`, `+++ b/path`, and Allr' own `a/path → b/path`
// arrow line. That preamble just repeats the path (which the tool row already
// shows) and reads especially badly for absolute paths (`a//Users/…`). Strip
// the leading header zone up to the first hunk.
const DIFF_HEADER_PREFIXES = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  'similarity ',
  'rename ',
  'new file',
  'deleted file'
]

function isArrowHeaderLine(line: string): boolean {
  const trimmed = line.trim()

  return trimmed.includes('→') && /^\S.*→\s*\S+$/.test(trimmed) && !/^[+\-@]/.test(trimmed)
}

/** Exported for tests. */
export function stripDiffFileHeaders(diff: string): string {
  const lines = diff.split('\n')
  let start = 0

  for (; start < lines.length; start += 1) {
    const line = lines[start]

    if (line.startsWith('@@')) {
      break
    }

    if (line.trim() === '' || isArrowHeaderLine(line) || DIFF_HEADER_PREFIXES.some(prefix => line.startsWith(prefix))) {
      continue
    }

    break
  }

  return lines.slice(start).join('\n')
}

function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = []
  let active: null | ParsedHunk = null

  for (const line of stripDiffFileHeaders(diff).split('\n')) {
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)

      if (!match) {
        active = null

        continue
      }

      active = { oldStart: Number(match[1]), newStart: Number(match[2]), lines: [] }
      hunks.push(active)

      continue
    }

    if (!active || line.startsWith('\\')) {
      continue
    }

    active.lines.push({ kind: diffKind(line), text: stripDiffMarker(line) })
  }

  return hunks
}

// Cleaned diff → renderable lines: file-headers + `@@` hunks dropped (a blank
// separator kept between hunks), markers stripped, kind recorded. Old/new line
// numbers are tracked from each `@@ -a,b +c,d @@` header so a caller that wants
// a gutter (the preview) can render them; the blank separator carries none.
function parseDiff(diff: string): DiffLine[] {
  const hunks = parseHunks(diff)

  if (hunks.length === 0) {
    // Fallback for unexpected non-hunk payloads.
    return stripDiffFileHeaders(diff)
      .split('\n')
      .map(line => ({ kind: diffKind(line), text: stripDiffMarker(line) }))
  }

  const out: DiffLine[] = []
  let emitted = false
  let oldNo = 1
  let newNo = 1

  for (const hunk of hunks) {
    oldNo = hunk.oldStart
    newNo = hunk.newStart

    if (emitted) {
      out.push({ kind: 'context', text: '' })
    }

    for (const line of hunk.lines) {
      const entry: DiffLine = { kind: line.kind, text: line.text }

      if (line.kind === 'add') {
        entry.newNo = newNo++
      } else if (line.kind === 'remove') {
        entry.oldNo = oldNo++
      } else {
        entry.oldNo = oldNo++
        entry.newNo = newNo++
      }

      out.push(entry)
      emitted = true
    }
  }

  return out
}

// Build a full-file diff view anchored to the CURRENT file text. Every current
// line is emitted from `fullText` with its real new-file line number; hunks only
// mark those rows as added and insert deleted rows between them. That keeps the
// preview's SOURCE and DIFF views on the same line map even when git returns
// compact hunks or removed-only rows.
function parseFullFileDiff(diff: string, fullText: string): DiffLine[] {
  const hunks = parseHunks(diff)
  const fullLines = fullText.split('\n')

  if (hunks.length === 0) {
    return fullLines.map((text, index) => ({ kind: 'context', newNo: index + 1, oldNo: index + 1, text }))
  }

  const added = new Set<number>()
  const oldNoByNewNo = new Map<number, number>()
  const removalsByNewNo = new Map<number, DiffLine[]>()
  const out: DiffLine[] = []

  for (const hunk of hunks) {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        added.add(newNo)
        newNo += 1
      } else if (line.kind === 'remove') {
        const anchor = Math.max(1, Math.min(newNo, fullLines.length + 1))
        const bucket = removalsByNewNo.get(anchor) ?? []

        bucket.push({ kind: 'remove', oldNo, text: line.text })
        removalsByNewNo.set(anchor, bucket)
        oldNo += 1
      } else {
        oldNoByNewNo.set(newNo, oldNo)
        oldNo += 1
        newNo += 1
      }
    }
  }

  for (let index = 0; index < fullLines.length; index += 1) {
    const newNo = index + 1
    const removals = removalsByNewNo.get(newNo)

    if (removals) {
      out.push(...removals)
    }

    out.push({
      kind: added.has(newNo) ? 'add' : 'context',
      newNo,
      oldNo: oldNoByNewNo.get(newNo),
      text: fullLines[index] ?? ''
    })
  }

  const trailingRemovals = removalsByNewNo.get(fullLines.length + 1)

  if (trailingRemovals) {
    out.push(...trailingRemovals)
  }

  return out
}

function DiffBody({ lines, syntax }: { lines: DiffLine[]; syntax?: boolean }) {
  return (
    <>
      {lines.map((line, index) => (
        <span
          className={cn(DIFF_LINE_BASE, DIFF_KIND_TINT[line.kind], !syntax && DIFF_KIND_TEXT[line.kind])}
          key={`${index}-${line.text}`}
        >
          {line.text || ' '}
        </span>
      ))}
    </>
  )
}

// shiki FontStyle is a bitmask: Italic=1, Bold=2, Underline=4.
function tokenStyle({ bgColor, color, fontStyle = 0 }: ThemedToken): React.CSSProperties | undefined {
  if (!color && !bgColor && !fontStyle) {
    return undefined
  }

  return {
    backgroundColor: bgColor,
    color,
    fontStyle: fontStyle & 1 ? 'italic' : undefined,
    fontWeight: fontStyle & 2 ? 700 : undefined,
    textDecorationLine: fontStyle & 4 ? 'underline' : undefined
  }
}

function useThemeName() {
  const current = () => (document.documentElement.classList.contains('dark') ? SHIKI_THEME.dark : SHIKI_THEME.light)
  const [theme, setTheme] = React.useState(current)

  React.useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()))

    observer.observe(document.documentElement, { attributeFilter: ['class'], attributes: true })

    return () => observer.disconnect()
  }, [])

  return theme
}

function PreviewDiffRows({
  afterLines = 0,
  beforeLines = 0,
  chunks,
  tokens
}: {
  afterLines?: number
  beforeLines?: number
  chunks: Array<LineChunk<DiffLine>>
  tokens?: ThemedToken[][] | null
}) {
  return (
    <>
      {beforeLines > 0 && <div aria-hidden style={{ height: beforeLines * PREVIEW_LINE_PX }} />}
      {chunks.map(chunk => (
        <div className="block" key={chunk.start}>
          {chunk.lines.map((line, offset) => {
            const index = chunk.start + offset
            const rowTokens = tokens?.[index] ?? []

            return (
              <span className={cn(PREVIEW_DIFF_LINE_BASE, DIFF_KIND_TINT[line.kind])} key={`${index}-${line.text}`}>
                {rowTokens.length > 0
                  ? rowTokens.map((token, tokenIndex) => (
                      <span key={`${tokenIndex}-${token.offset}`} style={tokenStyle(token)}>
                        {token.content}
                      </span>
                    ))
                  : line.text || ' '}
              </span>
            )
          })}
        </div>
      ))}
      {afterLines > 0 && <div aria-hidden style={{ height: afterLines * PREVIEW_LINE_PX }} />}
    </>
  )
}

function TokenizedDiffBody({
  afterLines,
  beforeLines,
  chunked = false,
  chunks,
  language,
  lineClassName = PREVIEW_DIFF_LINE_BASE,
  lines
}: {
  afterLines?: number
  beforeLines?: number
  chunked?: boolean
  chunks?: Array<LineChunk<DiffLine>>
  language: string
  /** Row class for the UNCHUNKED path. The windowed/preview rows are fixed
   *  height; a compact tool card keeps the auto-height row with the 2px gutter
   *  accent it has always had. */
  lineClassName?: string
  lines: DiffLine[]
}) {
  const code = React.useMemo(() => lines.map(line => line.text).join('\n'), [lines])
  const theme = useThemeName()
  const [tokens, setTokens] = React.useState<ThemedToken[][] | null>(null)

  React.useEffect(() => {
    let cancelled = false

    setTokens(null)
    // Dynamic: `shiki` must not be reachable statically from the transcript, or
    // the engine ships in the entry chunk however the fence highlighter is
    // loaded (MJXHRM-380). This call was already async, so deferring the module
    // with it costs nothing but one extra microtask on the first diff.
    void import('shiki')
      .then(({ codeToTokens }) => codeToTokens(code, { lang: language as BundledLanguage, theme }))
      .then(result => {
        if (!cancelled) {
          setTokens(result.tokens)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTokens([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  if (!tokens) {
    return chunked ? (
      <PreviewDiffRows
        afterLines={afterLines}
        beforeLines={beforeLines}
        chunks={chunks ?? chunkLines(lines, PREVIEW_CHUNK_LINES)}
      />
    ) : (
      <DiffBody lines={lines} />
    )
  }

  if (chunked) {
    return (
      <PreviewDiffRows
        afterLines={afterLines}
        beforeLines={beforeLines}
        chunks={chunks ?? chunkLines(lines, PREVIEW_CHUNK_LINES)}
        tokens={tokens}
      />
    )
  }

  return (
    <>
      {lines.map((line, index) => {
        const rowTokens = tokens[index] ?? []

        return (
          <span className={cn(lineClassName, DIFF_KIND_TINT[line.kind])} key={`${index}-${line.text}`}>
            {rowTokens.length > 0
              ? rowTokens.map((token, tokenIndex) => (
                  <span key={`${tokenIndex}-${token.offset}`} style={tokenStyle(token)}>
                    {token.content}
                  </span>
                ))
              : line.text || ' '}
          </span>
        )
      })}
    </>
  )
}

interface DiffLinesProps extends Omit<React.ComponentProps<'pre'>, 'children'> {
  text: string
}

export function DiffLines({ className, text, ...props }: DiffLinesProps) {
  const lines = React.useMemo(() => parseDiff(text), [text])

  return (
    <pre className={cn(DIFF_BOX_CLASS, className)} data-slot="diff-lines" {...props}>
      <DiffBody lines={lines} />
    </pre>
  )
}

// Coalesce consecutive same-kind changed rows into runs, each placed by line
// fraction (no DOM measurement). Context rows produce no tick.
function overviewRuns(lines: DiffLine[]): { kind: 'add' | 'remove'; sizePct: number; startPct: number }[] {
  const total = lines.length || 1
  const runs: { kind: 'add' | 'remove'; sizePct: number; startPct: number }[] = []

  for (let i = 0; i < lines.length;) {
    const kind = lines[i].kind

    if (kind === 'context') {
      i += 1

      continue
    }

    let j = i + 1

    while (j < lines.length && lines[j].kind === kind) {
      j += 1
    }

    runs.push({ kind, sizePct: ((j - i) / total) * 100, startPct: (i / total) * 100 })
    i = j
  }

  return runs
}

// VS Code-style overview ruler: a thin strip pinned to the diff's right edge with
// a green/red tick per change, positioned by line fraction. Pinned to the
// viewport (not the scrolled content) by living as an absolute sibling of the
// scroller inside a relative wrapper — so no scroll listener or measurement.
function DiffOverviewRuler({ lines }: { lines: DiffLine[] }) {
  const runs = React.useMemo(() => overviewRuns(lines), [lines])

  if (runs.length === 0) {
    return null
  }

  return (
    // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- over a surface pinned left-to-right — see the [dir='rtl'] block in styles.css
    <div aria-hidden className="pointer-events-none absolute top-0 right-0 bottom-0 w-1.5 opacity-80">
      {/* Cap the tick field to the diff's natural height (rows × line px) so a
          short diff renders thin, line-aligned ticks instead of stretching a few
          changes into gross full-height blocks. A long diff hits the 100% cap and
          compresses into a true overview. */}
      <div className="relative w-full" style={{ height: `min(100%, ${lines.length * PREVIEW_LINE_PX}px)` }}>
        {runs.map((run, index) => (
          <div
            className={cn('absolute inset-x-0', run.kind === 'add' ? 'bg-(--ui-green)' : 'bg-(--ui-red)')}
            key={index}
            style={{ height: `max(0.125rem, ${run.sizePct}%)`, top: `${run.startPct}%` }}
          />
        ))}
      </div>
    </div>
  )
}

interface FileDiffPanelProps {
  /** Override the default (tool-card) box styling — the full-height preview
   *  cancels the bleed/clamp so the diff fills its pane. */
  className?: string
  diff: string
  /** Current file text. When provided, the panel expands hunked diffs into a
   *  full-file view so unchanged lines are preserved between hunks. */
  fullText?: string
  path?: string
  /** Render an old/new line-number gutter (the full preview diff). The compact
   *  tool-card + inline review diff leave this off. */
  showLineNumbers?: boolean
  /** Window the rows (fixed-row virtualization) WITHOUT a gutter — for a large
   *  diff in a scrolling pane (the review panel), so only visible rows mount
   *  instead of highlighting every line. `showLineNumbers` implies windowing. */
  virtualized?: boolean
  /** Soft-wrap long lines instead of scrolling sideways. Reading a diff on a
   *  phone is mostly reading long lines, and a horizontal scrollbar is the one
   *  gesture a thumb is worst at. */
  wrap?: boolean
}

export function FileDiffPanel({
  className,
  diff,
  fullText,
  path,
  showLineNumbers = false,
  virtualized = false,
  wrap = false
}: FileDiffPanelProps) {
  const lines = React.useMemo(
    () => (fullText != null ? parseFullFileDiff(diff, fullText) : parseDiff(diff)),
    [diff, fullText]
  )

  const lineChunks = React.useMemo(() => chunkLines(lines, PREVIEW_CHUNK_LINES), [lines])

  const { afterRows, beforeRows, endChunk, onScroll, scrollerRef, startChunk } = useFixedRowWindow({
    overscanRows: PREVIEW_OVERSCAN_LINES,
    rowPx: PREVIEW_LINE_PX,
    rowsPerChunk: PREVIEW_CHUNK_LINES,
    totalRows: lines.length
  })

  const visibleLineChunks = lineChunks.slice(startChunk, endChunk + 1)

  const language = shikiLanguageForFilename(path)
  const canHighlight = Boolean(language) && !exceedsHighlightBudget(fullText ?? diff)
  // Wrapping and windowing are mutually exclusive, and the window is what gives
  // way. Both the fixed-row scroller and the line-number gutter beside it place
  // rows by multiplying an index by a constant row height; a wrapped line is
  // however many rows tall it needs to be, so the two would drift apart within a
  // screenful. A wrapped diff therefore renders every row — bounded by the same
  // highlight budget the tool cards use, and opt-in per file.
  // ponytail: unwindowed while wrapped. If a huge diff drags here, the fix is a
  // measuring virtualizer, not a smaller budget.
  const windowed = (showLineNumbers || virtualized) && !wrap

  // Windowed: we own fixed-height rows and render only the visible chunks, so a
  // large diff never mounts (or Shiki-highlights) every line. Compact tool cards
  // are small/clamped, so they render every row.
  const windowedBody = canHighlight ? (
    <TokenizedDiffBody
      afterLines={afterRows}
      beforeLines={beforeRows}
      chunked
      chunks={visibleLineChunks}
      language={language}
      lines={lines}
    />
  ) : (
    <PreviewDiffRows afterLines={afterRows} beforeLines={beforeRows} chunks={visibleLineChunks} />
  )

  // One tokenized path for both. The compact tool card used to get `SyntaxDiff`
  // (react-shiki's DOM) and keeps its own row class here so it still reads as
  // an auto-height row with the 2px gutter accent.
  const compactBody = !canHighlight ? (
    <DiffBody lines={lines} />
  ) : (
    <TokenizedDiffBody
      language={language}
      lineClassName={fullText != null ? undefined : DIFF_LINE_BASE}
      lines={lines}
    />
  )

  if (!windowed) {
    return (
      <div className={cn(DIFF_BOX_CLASS, className)} data-diff-wrap={wrap ? '' : undefined} data-slot="file-diff-panel">
        {compactBody}
      </div>
    )
  }

  // Windowed: a fixed-row scroller renders only the visible rows (killing the
  // full-Shiki-of-every-line freeze on large diffs). With `showLineNumbers` a
  // VS Code-style gutter (new number for context/adds, old for removals) sits in
  // a left column; the scroller owns scroll so the overview ruler (an absolute
  // sibling) stays viewport-fixed.
  return (
    <div className={cn(DIFF_BOX_CLASS, 'relative overflow-hidden', className)} data-slot="file-diff-panel">
      <div
        // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- this surface is itself pinned left-to-right — see the [dir='rtl'] block in styles.css
        className={cn('absolute inset-0 overflow-auto', showLineNumbers && 'pr-2.5')}
        onScroll={onScroll}
        ref={scrollerRef}
      >
        {showLineNumbers ? (
          <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)]">
            {/* eslint-disable-next-line better-tailwindcss/no-restricted-classes -- this surface is itself pinned left-to-right — see the [dir='rtl'] block in styles.css */}
            <div className="sticky left-0 z-1 select-none bg-(--ui-editor-surface-background) py-3 text-muted-foreground/55">
              {beforeRows > 0 && <div aria-hidden style={{ height: beforeRows * PREVIEW_LINE_PX }} />}
              {visibleLineChunks.map(chunk => (
                <div className="block" key={chunk.start}>
                  {chunk.lines.map((line, offset) => {
                    const index = chunk.start + offset

                    return (
                      <div
                        // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- this surface is itself pinned left-to-right — see the [dir='rtl'] block in styles.css
                        className="h-5 w-9 pr-2 text-right leading-5 tabular-nums"
                        key={`${index}-${line.oldNo}-${line.newNo}`}
                      >
                        {line.newNo ?? ''}
                      </div>
                    )
                  })}
                </div>
              ))}
              {afterRows > 0 && <div aria-hidden style={{ height: afterRows * PREVIEW_LINE_PX }} />}
            </div>
            <div className="min-w-0">{windowedBody}</div>
          </div>
        ) : (
          <div className="min-w-0">{windowedBody}</div>
        )}
      </div>
      <DiffOverviewRuler lines={lines} />
    </div>
  )
}
