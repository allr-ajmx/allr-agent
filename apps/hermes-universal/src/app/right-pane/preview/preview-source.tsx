import { type CSSProperties, useMemo } from 'react'

import { CodeTokenBody } from '@/components/ui/code-token-body'
import { exceedsHighlightBudget } from '@/lib/code-budget'
import { canTokenize, tokenizeCode } from '@/lib/code-tokens'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * The preview pane's SOURCE view, rendered by this app end to end.
 *
 * WHY THIS EXISTS. It used to render through `react-shiki`, which is the same
 * library chain ALLR-30 removed from the chat fence after a signed iOS build
 * collapsed every line of a fence onto one line — see the header comment on
 * `components/chat/code-fence.tsx`, which is the post-mortem. Here the same
 * chain showed up as the other end of that failure: the pane came up EMPTY with
 * the toolbar still on `source`, and tapping Edit (CodeMirror, which owns its
 * own DOM and metrics) filled it correctly. Two symptoms, one cause — a lazy
 * chunk, a WASM engine and three elements whose tags, classes and inline styles
 * belonged to a library.
 *
 * So this follows the fence's four structural rules:
 *
 *  1. WE render the elements.
 *  2. Nothing between the `<pre>` and the text is third-party: `<pre>` →
 *     `<code>` → text, or `<pre>` → `<code>` → our own `<span>`.
 *  3. No selector we depend on targets a third-party attribute. (The
 *     `.preview-source-code .shiki` block in styles.css did exactly that, was
 *     never applied by any component, and is deleted — its row metrics are the
 *     inline styles below.)
 *  4. Anything whose absence makes the view UNREADABLE OR GEOMETRICALLY WRONG
 *     is an INLINE STYLE. Font SIZE stays a class: a miss there is ugly, not
 *     unreadable.
 *
 * And the fence's fifth: colour is computed synchronously by `lib/code-tokens`,
 * so there is no chunk, no engine and no async state — hence no empty state to
 * fall into. A language that module has no grammar for is not an error; it
 * renders as plain, complete text, which is what this whole view degrades to.
 */

/**
 * Inline for the reasons in the fence's header: a class can be purged by content
 * detection, rewritten by Lightning CSS, out-ranked by a cascade layer, or
 * scoped to a selector that quietly stops matching.
 *
 * `white-space: pre` is the whole bug, so it is set HERE and again on the
 * `<code>`. `word-break`/`overflow-wrap` INHERIT, so they are pinned rather than
 * left to an ancestor. `line-height` is the fixed editor row height the deleted
 * `.preview-source-code` rules used to supply, so source⇄diff toggling does not
 * shift. Unlike the transcript's fence this `<pre>` IS the pane's scroller —
 * both axes, and no wrapper scroller around it, because a scroller inside a
 * scroller was part of the DOM ALLR-30 was fighting.
 */
const SOURCE_PRE_STYLE: CSSProperties = {
  WebkitTextSizeAdjust: '100%',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  height: '100%',
  lineHeight: '1.25rem',
  margin: 0,
  overflowWrap: 'normal',
  overflowX: 'auto',
  overflowY: 'auto',
  overscrollBehaviorX: 'contain',
  padding: '0.5rem 0.625rem',
  tabSize: 2,
  whiteSpace: 'pre',
  wordBreak: 'normal'
}

/** `min-width: max-content` so selection and background span the scrolled width. */
const SOURCE_CODE_STYLE: CSSProperties = {
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

export interface PreviewSourceProps {
  className?: string
  /** The file's language tag. Anything `lib/code-tokens` does not know renders
   *  as plain text — never as nothing. */
  language: string
  text: string
}

export function PreviewSource({ className, language, text }: PreviewSourceProps) {
  const { state, tokens } = useMemo(() => {
    if (!text) {
      return { state: 'plain' as const, tokens: null }
    }

    if (!canTokenize(language)) {
      // No grammar for this tag. `tokenizeCode` would return one plain token
      // holding the whole file; skipping the call says the same thing with less
      // work, and both land on the un-tokenized branch below.
      return { state: 'unsupported' as const, tokens: null }
    }

    if (exceedsHighlightBudget(text)) {
      // Plain text past the budget. The old Shiki path tokenised the whole file
      // in one synchronous pass, so a big file froze the entire UI — not the
      // pane, the app — for as long as that took, and this view happily loaded
      // half a megabyte. Same DOM either way, so nothing moves when it trips.
      return { state: 'over-budget' as const, tokens: null }
    }

    try {
      return { state: 'tokens' as const, tokens: tokenizeCode(text, language) }
    } catch {
      // `tokenizeCode` is total — it catches its own faults and falls back to a
      // single plain token. This second net keeps that true if it ever
      // regresses: the view sheds its COLOURS, never its CONTENT.
      return { state: 'plain' as const, tokens: null }
    }
  }, [language, text])

  return (
    <pre
      className={cn(
        'scrollbar-overlay',
        // Read mode is where most phone time is spent — 0.7rem of mono is not a
        // reading size on a handset.
        IS_MOBILE ? 'text-[0.8rem]' : 'text-[0.7rem]',
        className
      )}
      data-highlight={state}
      data-language={language || undefined}
      data-slot="preview-source-pre"
      dir="ltr"
      style={SOURCE_PRE_STYLE}
    >
      <code data-slot="preview-source-code" style={SOURCE_CODE_STYLE}>
        {tokens ? <CodeTokenBody tokens={tokens} /> : text}
      </code>
    </pre>
  )
}
