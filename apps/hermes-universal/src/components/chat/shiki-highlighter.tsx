import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown'
import { type FC, lazy, type ReactNode, Suspense, useEffect, useMemo, useRef } from 'react'

import { CodeCard, CodeCardBody } from '@/components/chat/code-card'
import { ErrorBoundary } from '@/components/error-boundary'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { chunkByLines, exceedsHighlightBudget } from '@/lib/code-budget'
import { isLikelyProseCodeBlock, sanitizeLanguageTag } from '@/lib/markdown-code'
import { IS_MOBILE } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { isRecording, recordSpan } from '@/observability'

/**
 * Streamdown's code adapter renders header + body as inline siblings, so we
 * own the wrapping `<CodeCard>` here and neutralize the upstream
 * `data-streamdown="code-block"` chrome from styles.css. The card is
 * background-only — no header row, no language label — so a fence reads as a
 * tinted slab of the reply; copy is a hover-reveal control in the corner.
 *
 * `react-shiki` full bundle so all `bundledLanguages` work; theme switches
 * follow the document `color-scheme` via `defaultColor="light-dark()"`.
 *
 * The engine is reached through ONE lazy boundary (`./shiki-block`), matching
 * desktop's `lazy(() => import('./shiki-block'))`. Everything above that
 * boundary — the card, the copy button, the budget fallback — stays eager, so a
 * fence paints its slab immediately and fills in highlighted once the chunk
 * lands. `PlainCode` is the Suspense fallback for exactly that reason: it is
 * already what an over-budget or still-streaming fence renders, so the
 * un-highlighted → highlighted transition is one the transcript already makes.
 * It doubles as the error fallback: the same reasoning says a fence whose
 * engine never arrives should lose its colours, not its content.
 *
 * The card does NOT clamp its height. A fence renders at its natural size and
 * the transcript viewport is the only vertical scroller, matching the file-diff
 * panel — one gesture scrolls a reply rather than trapping it in a 7.5rem box
 * behind a chevron. Fences long enough to drown a reply never get here: they are
 * promoted to an artifact card upstream (`lib/artifact-detect.ts`).
 */
interface HermesSyntaxHighlighterProps extends SyntaxHighlighterProps {
  defer?: boolean
}

// Re-exported so existing importers keep working; the values now live in
// `shiki-theme.ts`, which is safe to import without pulling in the engine.
export { SHIKI_THEME } from '@/components/chat/shiki-theme'

const ShikiBlock = lazy(() => import('@/components/chat/shiki-block'))

const CHUNK_LINES = 200
const EST_LINE_PX = 16

/**
 * Time-to-highlighted, per code block.
 *
 * `react-shiki` highlights in an async effect and keeps the result in
 * component-local `useState`, so there is no call to wrap — the work has no
 * synchronous boundary to bracket. What CAN be observed is the moment
 * highlighted markup appears: Shiki emits inline-styled token spans, so their
 * first appearance under this ref is the answer to "how long did the reader
 * look at unstyled code".
 *
 * That indirectness is itself the finding worth recording. Because the result
 * lives in component state rather than a shared cache, every unmount throws it
 * away — and this transcript recycles code blocks via `content-visibility`, so
 * the same block is re-highlighted from scratch each time it comes back. The
 * span count on a single session says how often that happens.
 */
const HighlightTimer: FC<{ children: ReactNode; language: string }> = ({ children, language }) => {
  const host = useRef<HTMLSpanElement>(null)
  const startedAt = useRef(performance.now())
  const settled = useRef(false)

  // No dependency array: this must run after EVERY render, because the render
  // that finally brings highlighted markup in is triggered by react-shiki's own
  // state update, not by anything this component can depend on.
  useEffect(() => {
    if (settled.current || !isRecording() || !host.current?.querySelector('span[style]')) {
      return
    }

    settled.current = true
    recordSpan('shiki.time-to-highlighted', startedAt.current, performance.now(), { language })
  })

  return (
    <span className="contents" ref={host}>
      {children}
    </span>
  )
}

/**
 * `content-visibility:auto` is a DESKTOP-ONLY optimization here.
 *
 * It buys off-screen chunks of a long fence out of style/layout/paint, which is
 * worth real milliseconds on a transcript full of them. But it is only correct
 * where `contain-intrinsic-size: auto <length>` is honoured: without the
 * remembered size the skipped chunk collapses to 0x0, and a card whose every
 * chunk is 0 tall paints as a slab of bare padding — a code block that looks
 * EMPTY. Both mobile webviews were reported doing exactly that, so the phone
 * takes the slower, unconditionally-rendered path. Same lesson the transcript's
 * own virtualization already carries (`thread/list.tsx`): containment needs a
 * gate to stay correct, not just fast.
 */
const CHUNK_CONTAINMENT_CLASS = IS_MOBILE ? '' : '[content-visibility:auto]'

const PlainCode: FC<{ code: string }> = ({ code }) => {
  const chunks = useMemo(() => chunkByLines(code, CHUNK_LINES), [code])

  if (chunks.length === 1) {
    return <code className="block whitespace-pre">{code}</code>
  }

  return (
    <>
      {chunks.map((chunk, index) => (
        <code
          className={cn('block whitespace-pre', CHUNK_CONTAINMENT_CLASS)}
          key={index}
          style={IS_MOBILE ? undefined : { containIntrinsicSize: `auto ${chunk.lines * EST_LINE_PX}px` }}
        >
          {chunk.text}
        </code>
      ))}
    </>
  )
}

export const SyntaxHighlighter: FC<HermesSyntaxHighlighterProps> = ({
  components: { Pre },
  language,
  code,
  defer = false
}) => {
  const { t } = useI18n()
  const trimmed = (code ?? '').replace(/^\n+/, '').trimEnd()

  // Streaming may hand us empty/incomplete fences — render nothing rather
  // than a transient empty card.
  if (!trimmed.trim()) {
    return null
  }

  if (isLikelyProseCodeBlock(language, trimmed)) {
    return <div className="aui-prose-fence whitespace-pre-wrap wrap-anywhere text-foreground">{trimmed}</div>
  }

  // Trace label only — the card shows no language chip any more.
  const cleanLanguage = sanitizeLanguageTag(language || '')
  const plain = defer || exceedsHighlightBudget(trimmed)

  return (
    <CodeCard data-streaming={defer ? 'true' : undefined}>
      <CopyButton
        appearance="inline"
        // eslint-disable-next-line better-tailwindcss/no-restricted-classes -- over a surface pinned left-to-right — see the [dir='rtl'] block in styles.css
        className="absolute right-1.5 top-1.5 z-10 h-5 gap-0 rounded-md px-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        iconClassName="size-2.5"
        label={t.assistant.tool.copyCode}
        showLabel={false}
        text={trimmed}
      />
      <CodeCardBody className="[&_pre]:px-3 [&_pre]:py-2.5">
        {/* `overflow-y-hidden` pairs with the `overflow-x-auto` CodeCardBody puts on
            every `pre`: with y left visible the spec promotes it to `auto` next to a
            scrolling x-axis, handing the fence a second vertical scroller. The
            transcript viewport owns that axis. `overscroll-x-contain` keeps a
            sideways overscroll on a long line from firing browser back/forward. */}
        <Pre className="aui-shiki m-0 overflow-y-hidden overscroll-x-contain bg-transparent p-0">
          {plain ? (
            <PlainCode code={trimmed} />
          ) : (
            <HighlightTimer language={cleanLanguage || 'text'}>
              {/* A fence that cannot be HIGHLIGHTED must still be READABLE. The
                  engine sits behind a lazy import, so a failed chunk fetch (or
                  any throw inside react-shiki) rejects during render; with no
                  boundary here that escapes to the turn-level
                  MessageRenderBoundary and takes the whole reply's markdown
                  with it. Falling back to the same PlainCode the Suspense
                  fallback already uses degrades one fence to un-coloured code
                  and leaves the rest of the message alone. */}
              <ErrorBoundary fallback={() => <PlainCode code={trimmed} />} label="code-fence">
                <Suspense fallback={<PlainCode code={trimmed} />}>
                  <ShikiBlock language={language || 'text'}>{trimmed}</ShikiBlock>
                </Suspense>
              </ErrorBoundary>
            </HighlightTimer>
          )}
        </Pre>
      </CodeCardBody>
    </CodeCard>
  )
}
