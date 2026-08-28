import { type CSSProperties, type RefObject, useEffect, useMemo, useRef } from 'react'

import { CodeCard } from '@/components/chat/code-card'
import { CodeTokenBody, TOKEN_COLOR } from '@/components/ui/code-token-body'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { exceedsHighlightBudget } from '@/lib/code-budget'
import { canTokenize, tokenizeCode } from '@/lib/code-tokens'
import { isLikelyProseCodeBlock, sanitizeLanguageTag } from '@/lib/markdown-code'
import { isRecording, recordSpan } from '@/observability'

/**
 * A code fence this app owns end to end.
 *
 * WHY THIS EXISTS. The previous fence rendered through assistant-ui's code
 * adapter into react-shiki, so the live DOM was
 * `<pre.aui-shiki>` → `div.rs-root` → `pre.shiki` → `code` → `span.line`: a
 * `<pre>` nested inside a `<pre>`, a scroller inside a scroller, and three
 * elements whose tags, classes and inline styles belonged to a library. In a
 * signed iOS build every line of a fence collapsed onto ONE LINE; the same
 * commit on the same phone was fine under `dev:ext:ios`, and ALLR-30 never
 * established which link in that chain did it. Notably, the shipped fix set
 * `white-space: pre` through the selector
 * `[data-streamdown='code-block'] code`, which matches NOTHING in either mode —
 * the adapter replaces the only component that emits that attribute.
 *
 * So the rules here are structural, not cosmetic:
 *
 *  1. WE render the elements. The adapter hands us `components.Pre`/`Code` and
 *     `CodeFenceProps` deliberately cannot express them, so there is no way to
 *     accidentally hand the DOM back.
 *  2. Nothing between the `<pre>` and the text is third-party: `<pre>` → `<code>`
 *     → text, or `<pre>` → `<code>` → our own `<span>`.
 *  3. No selector we depend on targets a third-party attribute.
 *  4. Anything whose absence makes the fence UNREADABLE OR GEOMETRICALLY WRONG
 *     is an INLINE STYLE — see the constants below. Anything whose absence just
 *     makes it ugly stays a class.
 *  5. Colour is computed synchronously from `lib/code-tokens` (no chunk, no
 *     engine, no WASM, no async state), and a fence with no colour is still a
 *     fence with all its text.
 *
 * The `<pre>` being a REAL `<pre>` is load-bearing, not ceremonial: styles.css
 * has `.aui-md :not(pre) > code { ...inline-code chrome... }`, so a `<div>`
 * dressed as a `<pre>` would paint inline-code chrome over every fence.
 */

/**
 * Inline because a class can be purged by content detection, rewritten by
 * Lightning CSS, out-ranked by a cascade layer, or scoped to a selector that
 * quietly stops matching — and every one of those was a live hypothesis for
 * ALLR-30. An inline style survives all four.
 *
 * `white-space: pre` is the whole bug, so it is set HERE and again on the
 * `<code>`: neither element on its own is a single point of failure.
 * `word-break`/`overflow-wrap` INHERIT, and this transcript is full of
 * `wrap-anywhere`, so an ancestor gaining one would reflow code mid-identifier.
 * Both overflow axes are named because the spec promotes a `visible` axis to
 * `auto` beside a scrolling one, which is what hands a fence a second vertical
 * scroller — the transcript viewport owns that axis.
 */
const FENCE_PRE_STYLE: CSSProperties = {
  WebkitTextSizeAdjust: '100%',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 'inherit',
  lineHeight: 'inherit',
  margin: 0,
  overflowWrap: 'normal',
  overflowX: 'auto',
  overflowY: 'hidden',
  overscrollBehaviorX: 'contain',
  padding: '0.625rem 0.75rem',
  tabSize: 2,
  whiteSpace: 'pre',
  wordBreak: 'normal'
}

/** `min-width: max-content` so selection and background span the scrolled width. */
const FENCE_CODE_STYLE: CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  display: 'block',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  lineHeight: 'inherit',
  minWidth: 'max-content',
  overflowWrap: 'normal',
  tabSize: 2,
  whiteSpace: 'pre',
  wordBreak: 'normal'
}

export interface CodeFenceProps {
  className?: string
  code: string
  /** Hover-reveal copy control. Off where the host already provides one. */
  copy?: boolean
  language?: string
  /** Fence-shaped prose renders as wrapped text, not a card. */
  proseEscape?: boolean
  /** True while the message part is running: no tokenizing until the text settles. */
  streaming?: boolean
}

const countLines = (code: string): number => {
  let lines = 1

  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) {
    lines += 1
  }

  return lines
}

/**
 * ALLR-30's mechanism was never found — this component makes it unreachable
 * rather than explaining it. That distinction is worth keeping observable, so
 * the first multi-line fence of a recorded session reports what the device
 * actually resolved. A report of `whiteSpace !== 'pre'`, or a single client rect
 * for a many-line fence, IS the mechanism, captured from a real signed build
 * instead of inferred from the built CSS.
 *
 * Once per session, behind `isRecording()`, and never on the streaming path.
 */
let geometryProbed = false

function useGeometryProbe(ref: RefObject<HTMLElement | null>, lines: number): void {
  useEffect(() => {
    const node = ref.current

    if (geometryProbed || !node || lines < 2 || !isRecording() || typeof getComputedStyle !== 'function') {
      return
    }

    geometryProbed = true

    const startedAt = performance.now()
    const { whiteSpace } = getComputedStyle(node)

    recordSpan('code-fence.geometry', startedAt, performance.now(), {
      lines: String(lines),
      rects: String(node.getClientRects().length),
      whiteSpace
    })
  }, [lines, ref])
}

export function CodeFence({
  className,
  code,
  copy = true,
  language,
  proseEscape = true,
  streaming = false
}: CodeFenceProps) {
  const { t } = useI18n()
  const preRef = useRef<HTMLPreElement>(null)

  // Streaming hands us empty and half-written fences; render nothing rather
  // than flashing an empty card.
  const trimmed = (code ?? '').replace(/^\n+/, '').trimEnd()
  const cleanLanguage = sanitizeLanguageTag(language ?? '')
  const isProse = proseEscape && isLikelyProseCodeBlock(language, trimmed)

  const { state, tokens } = useMemo(() => {
    if (!trimmed || isProse) {
      return { state: 'plain' as const, tokens: null }
    }

    if (streaming) {
      return { state: 'streaming' as const, tokens: null }
    }

    if (!canTokenize(cleanLanguage)) {
      return { state: 'unsupported' as const, tokens: null }
    }

    if (exceedsHighlightBudget(trimmed)) {
      return { state: 'over-budget' as const, tokens: null }
    }

    const startedAt = performance.now()

    try {
      const result = tokenizeCode(trimmed, cleanLanguage)

      if (isRecording()) {
        // `spans`, not just `tokens`: a plain token renders as a bare text node
        // and a coloured one renders as an inline `<span>`, so only the coloured
        // count says how much INLINE LAYOUT this fence adds. That is the number
        // that decides whether fences are worth containing — a transcript's
        // total across a capture is the evidence, and without it the question
        // can only be argued.
        let coloured = 0

        for (const token of result) {
          if (TOKEN_COLOR[token.kind]) {
            coloured += 1
          }
        }

        recordSpan('code-fence.tokenized', startedAt, performance.now(), {
          chars: trimmed.length,
          language: cleanLanguage,
          lines: countLines(trimmed),
          spans: coloured,
          tokens: result.length
        })
      }

      return { state: 'tokens' as const, tokens: result }
    } catch {
      // `tokenizeCode` is total — it catches its own faults and falls back to a
      // single plain token. This second net is here so that stays true even if
      // that ever regresses: the fence sheds its COLOURS, never its CONTENT.
      // There is no ErrorBoundary above this any more, and the nearest one is
      // the turn-level MessageRenderBoundary, which would take the whole
      // reply's markdown down with one bad fence.
      return { state: 'plain' as const, tokens: null }
    }
  }, [cleanLanguage, isProse, streaming, trimmed])

  const lines = trimmed ? countLines(trimmed) : 0

  useGeometryProbe(preRef, lines)

  if (!trimmed) {
    return null
  }

  if (isProse) {
    return <div className="aui-prose-fence whitespace-pre-wrap wrap-anywhere text-foreground">{trimmed}</div>
  }

  return (
    <CodeCard className={className} data-streaming={streaming ? 'true' : undefined}>
      {copy ? (
        <CopyButton
          appearance="inline"
          // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- over a surface pinned left-to-right — see the [dir='rtl'] block in styles.css
          className="absolute right-1.5 top-1.5 z-10 h-5 gap-0 rounded-md px-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
          iconClassName="size-2.5"
          label={t.assistant.tool.copyCode}
          showLabel={false}
          text={trimmed}
        />
      ) : null}
      {/* `data-slot` kept so the streaming glow and bottom mask in styles.css
          keep matching. Font and size stay classes: theme-tokened, and a miss
          is ugly rather than unreadable. */}
      <div className="font-mono text-[0.7rem] leading-relaxed text-foreground/90" data-slot="code-card-body">
        <pre
          className="scrollbar-overlay"
          data-highlight={state}
          data-language={cleanLanguage || undefined}
          data-slot="code-fence-pre"
          dir="ltr"
          ref={preRef}
          style={FENCE_PRE_STYLE}
        >
          <code data-lines={lines} data-slot="code-fence-code" style={FENCE_CODE_STYLE}>
            {tokens ? <CodeTokenBody tokens={tokens} /> : trimmed}
          </code>
        </pre>
      </div>
    </CodeCard>
  )
}
