import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown'
import { type FC, type ReactNode, useEffect, useMemo, useRef } from 'react'
import ShikiHighlighter from 'react-shiki'

import {
  CodeCard,
  CodeCardBody,
  CodeCardHeader,
  CodeCardIcon,
  CodeCardSubtitle,
  CodeCardTitle
} from '@/components/chat/code-card'
import { ExpandableBlock } from '@/components/chat/expandable-block'
import { CopyButton } from '@/components/ui/copy-button'
import { useI18n } from '@/i18n'
import { codiconForLanguage, isLikelyProseCodeBlock, sanitizeLanguageTag } from '@/lib/markdown-code'
import { isRecording, recordSpan } from '@/observability'

/**
 * Streamdown's code adapter renders header + body as inline siblings, so we
 * own the wrapping `<CodeCard>` here and neutralize the upstream
 * `data-streamdown="code-block"` chrome from styles.css.
 *
 * `react-shiki` full bundle so all `bundledLanguages` work; theme switches
 * follow the document `color-scheme` via `defaultColor="light-dark()"`.
 */
interface HermesSyntaxHighlighterProps extends SyntaxHighlighterProps {
  defer?: boolean
}

// `github-dark-dimmed` is GitHub's lower-contrast dark palette — the vivid
// `github-dark-default` tokens read harsh at our small code size. Shared by the
// inline diff renderer too (see diff-lines.tsx) so code + diffs match.
export const SHIKI_THEME = { dark: 'github-dark-dimmed', light: 'github-light-default' } as const

// `github-light-default` colors comments `#6e7781` — borderline unreadable at
// our 11px code size. Remap light-mode comments to GitHub's darker muted gray.
const SHIKI_COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  'github-light-default': { '#6e7781': '#57606a' }
}

const MAX_HIGHLIGHT_CHARS = 150_000
const MAX_HIGHLIGHT_LINES = 3_000
const CHUNK_LINES = 200
const EST_LINE_PX = 16

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

interface CodeChunk {
  text: string
  lines: number
}

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

const PlainCode: FC<{ code: string }> = ({ code }) => {
  const chunks = useMemo(() => chunkByLines(code, CHUNK_LINES), [code])

  if (chunks.length === 1) {
    return <code className="block whitespace-pre">{code}</code>
  }

  return (
    <>
      {chunks.map((chunk, index) => (
        <code
          className="block whitespace-pre [content-visibility:auto]"
          key={index}
          style={{ containIntrinsicSize: `auto ${chunk.lines * EST_LINE_PX}px` }}
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

  const cleanLanguage = sanitizeLanguageTag(language || '')
  const label = cleanLanguage && cleanLanguage !== 'unknown' ? cleanLanguage : ''
  const plain = defer || exceedsHighlightBudget(trimmed)

  return (
    <CodeCard data-streaming={defer ? 'true' : undefined}>
      <CodeCardHeader>
        <CodeCardTitle>
          <CodeCardIcon name={codiconForLanguage(label)} />
          {t.assistant.tool.code}
          {label && <CodeCardSubtitle> · {label}</CodeCardSubtitle>}
        </CodeCardTitle>
        <CopyButton
          appearance="inline"
          className="-my-1 -mr-1 h-5 px-1 opacity-55 hover:opacity-100"
          iconClassName="size-2.5"
          label={t.assistant.tool.copyCode}
          showLabel={false}
          text={trimmed}
        />
      </CodeCardHeader>
      <CodeCardBody>
        <ExpandableBlock>
          <Pre className="aui-shiki m-0 overflow-hidden bg-transparent p-0">
            {plain ? (
              <PlainCode code={trimmed} />
            ) : (
              <HighlightTimer language={cleanLanguage || 'text'}>
                <ShikiHighlighter
                  addDefaultStyles={false}
                  as="div"
                  colorReplacements={SHIKI_COLOR_REPLACEMENTS}
                  defaultColor="light-dark()"
                  delay={120}
                  language={language || 'text'}
                  showLanguage={false}
                  theme={SHIKI_THEME}
                >
                  {trimmed}
                </ShikiHighlighter>
              </HighlightTimer>
            )}
          </Pre>
        </ExpandableBlock>
      </CodeCardBody>
    </CodeCard>
  )
}
