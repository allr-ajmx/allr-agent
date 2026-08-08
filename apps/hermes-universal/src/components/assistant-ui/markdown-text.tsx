import { TextMessagePartProvider, useAuiState, useMessagePartText } from '@assistant-ui/react'
import {
  parseMarkdownIntoBlocks,
  type StreamdownTextComponents,
  StreamdownTextPrimitive,
  type SyntaxHighlighterProps,
  tailBoundedRemend
} from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import type { Element as HastElement } from 'hast'
import { type ComponentProps, memo, useEffect, useMemo, useState } from 'react'

import { ExpandableBlock } from '@/components/chat/expandable-block'
import { chunkByLines, SyntaxHighlighter } from '@/components/chat/shiki-highlighter'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { normalizeExternalUrl, openExternalLink, PrettyLink } from '@/lib/external-link'
import { createMemoizedMathPlugin, KATEX_HTML_TAG } from '@/lib/katex-memo'
import { preprocessMarkdown } from '@/lib/markdown-preprocess'
import {
  downloadGatewayMediaFile,
  gatewayMediaDataUrl,
  mediaKind,
  mediaName,
  mediaPathFromMarkdownHref,
  resolveMediaDisplaySrc
} from '@/lib/media'
import { isMediaStreamUrl } from '@/lib/media-stream'
import { cn } from '@/lib/utils'
import { span } from '@/observability'

import { detectEmbed, extractAlert, MarkdownAlert, RichCodeBlock, UrlEmbed } from './embeds'

// Math rendering plugin (KaTeX). Configured once at module scope — the plugin
// is stateless beyond its internal cache, so re-creating it per render would
// only thrash that cache.
//
// The memoizing rehype-katex wrapper (lib/katex-memo, ported from desktop)
// keys every equation on (displayMode, source) in a process-global LRU. The
// stock @streamdown/math plugin re-runs KaTeX over EVERY equation on every
// markdown commit — each streaming token, and each remount (session switch,
// message-list churn) — so a math-heavy transcript pays the full render cost
// again and again. Memoized, the steady-state work is proportional to "new
// equations arriving" instead of "equations × commits".
//
// `singleDollarTextMath: true` enables `$x^2$` inline math (the de-facto LLM
// convention); the default only accepts `$$…$$`.
const mathPlugin = createMemoizedMathPlugin({ singleDollarTextMath: true })

// Renderer for the single node katex-memo emits per equation. See that file for
// why an equation is one node and not ~65.
//
// Why writing innerHTML here is safe: the string is produced only by
// `katex.renderToString` with `trust` left at its default `false`, which
// disables every command that could emit a URL or a source-derived attribute
// (`\href`, `\url`, `\html*`, `\includegraphics`). KaTeX generates the markup
// from its own parse tree and escapes text itself, and katex-memo's error
// branches escape the source before interpolating it. The full argument lives
// in the `renderMath` doc comment — read it before changing either side.
//
// Why the tag survives streamdown's sanitizer: streamdown appends
// `plugins.math.rehypePlugin` AFTER rehype-sanitize (see the `Lt` memo in
// streamdown's bundle), which is the same slot stock rehype-katex uses to get
// its raw spans through. A `katex-html` element created by an EARLIER plugin
// would be unwrapped by the sanitizer instead — so this only works from the
// math plugin slot. Don't move it.
//
// memo on the html string: an equation's markup never changes once rendered, so
// re-renders of the surrounding message skip it entirely.
const KatexHtml = memo(
  function KatexHtml({ node }: { node?: HastElement }) {
    const first = node?.children?.[0]
    const html = first && first.type === 'text' ? first.value : ''
    const display = node?.properties?.dataDisplay === 'true'

    return (
      <span
        className="katex-host"
        // KaTeX-generated markup only — see the safety argument above and in
        // katex-memo's `renderMath`.
        dangerouslySetInnerHTML={{ __html: html }}
        data-display={display ? 'true' : 'false'}
      />
    )
  },
  (a, b) => {
    const aFirst = a.node?.children?.[0]
    const bFirst = b.node?.children?.[0]

    return (
      a.node?.properties?.dataDisplay === b.node?.properties?.dataDisplay &&
      (aFirst?.type === 'text' ? aFirst.value : '') === (bFirst?.type === 'text' ? bFirst.value : '')
    )
  }
)

// Both caches below are string→value LRUs keyed on the EXACT source text.
// These transforms are pure, so the same input always maps to the same output
// and a hit is always sound. Map iteration order is insertion order, so the
// oldest entry sits at the head.
//
// What they're for: REMOUNTS. A session switch or message-list churn re-renders
// settled messages whose text hasn't changed, and without a cache each one
// re-runs the full preprocess + lex. A streaming message instead produces a new
// distinct string per token, so it only ever misses and churns the LRU — that's
// no worse than not caching, but it's why the limit is generous enough that one
// streaming burst can't evict everything a later session switch wants.
const TEXT_CACHE_LIMIT = 256

// `label` is for tracing only. Spanning the MISS and counting the hit rate
// together is what makes these caches legible: a high miss rate on settled text
// means the cache is being defeated, while a slow miss means the transform
// itself is expensive, and the two want completely different fixes. Streaming
// text misses by construction — each token makes a new key — so a high miss
// rate is only interesting once a message has stopped growing.
function memoizeByText<T>(label: string, compute: (text: string) => T, limit: number) {
  const cache = new Map<string, T>()

  return (text: string): T => {
    const hit = cache.get(text)

    if (hit !== undefined) {
      cache.delete(text)
      cache.set(text, hit)

      return hit
    }

    const value = span(label, () => compute(text), { chars: text.length })

    cache.set(text, value)

    if (cache.size > limit) {
      cache.delete(cache.keys().next().value as string)
    }

    return value
  }
}

// Replaces Streamdown's `parseIncompleteMarkdown` (full-text remend per flush)
// with a tail-bounded repair over our own preprocessing. Module-scope so the
// prop identity is stable across renders.
//
// Memoized because Streamdown keys its `preprocess` useMemo on the whole
// messagePart OBJECT, not on the text — so without a cache this re-runs on
// every flush and every remount (session switch, message-list churn), and
// preprocessMarkdown is a dozen full-text regex passes.
const preprocessWithTailRepair = memoizeByText(
  'markdown.preprocess',
  function preprocessWithTailRepair(text: string): string {
    try {
      return tailBoundedRemend(preprocessMarkdown(text))
    } catch {
      return text
    }
  },
  TEXT_CACHE_LIMIT
)

// Memoized block splitter. Streamdown lexes the whole message on every REMOUNT
// (virtualizer scroll, session switch); the LRU removes those repeat parses.
const parseMarkdownIntoBlocksCached = memoizeByText('markdown.block-lex', parseMarkdownIntoBlocks, TEXT_CACHE_LIMIT)

function childrenToText(children: unknown): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children).trim()
  }

  if (Array.isArray(children) && children.every(c => typeof c === 'string' || typeof c === 'number')) {
    return children.join('').trim()
  }

  return ''
}

// The media file lives on the gateway, so "open" fetches the bytes over the
// authenticated bridge and hands them to the webview as a download.
function useOpenMediaFile(path: string) {
  const [openFailed, setOpenFailed] = useState(false)

  const open = () => {
    setOpenFailed(false)
    void downloadGatewayMediaFile(path).catch(() => setOpenFailed(true))
  }

  return { open, openFailed }
}

function OpenMediaFailedNote({ name }: { name: string }) {
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      Couldn&apos;t fetch {name} from the gateway (missing, unreadable, or too large).
    </span>
  )
}

function OpenMediaButton({ kind, path }: { kind: 'audio' | 'video'; path: string }) {
  const { open, openFailed } = useOpenMediaFile(path)

  return (
    <span className="block">
      <button
        className="mt-2 bg-transparent text-xs font-medium text-muted-foreground underline underline-offset-4 decoration-current/20 hover:text-foreground"
        onClick={open}
        type="button"
      >
        Open {kind} file
      </button>
      {openFailed && <OpenMediaFailedNote name={mediaName(path)} />}
    </span>
  )
}

// Renders a `#media:` attachment: images/audio/video inline, other kinds (and
// load failures) fall back to a download link. Ported from desktop's
// MediaAttachment; audio/video resolve to the `hermes-media://` streaming URL
// (see lib/media-stream.ts) with a one-shot data-URL retry behind them.
function MediaAttachment({ path }: { path: string }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const [triedFallback, setTriedFallback] = useState(false)
  const { open, openFailed } = useOpenMediaFile(path)
  const kind = mediaKind(path)
  const name = mediaName(path)

  /**
   * The stream URL can legitimately fail where the data URL still works: a
   * hosted gateway confines `/api/files/download` to its managed root while
   * `/api/fs/read-data-url` is unconfined, files over 100 MB are refused, and an
   * older gateway may not serve the endpoint at all. Try the data URL once
   * before surfacing the "Open …" fallback.
   */
  const handleMediaError = () => {
    if (triedFallback || !isMediaStreamUrl(src)) {
      setFailed(true)

      return
    }

    setTriedFallback(true)
    void gatewayMediaDataUrl(path)
      .then(setSrc)
      .catch(() => setFailed(true))
  }

  useEffect(() => {
    let cancelled = false

    setFailed(false)
    setTriedFallback(false)
    setSrc('')

    if (kind === 'file') {
      setFailed(true)

      return () => {
        cancelled = true
      }
    }

    void resolveMediaDisplaySrc(path)
      .then(value => {
        if (!cancelled) {
          setSrc(value)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [kind, path])

  if (kind === 'image' && src) {
    return (
      <span className="block">
        <MarkdownImage alt={name} src={src} />
      </span>
    )
  }

  if (kind === 'audio' && src) {
    return (
      <span className="my-3 block max-w-md rounded-xl border border-border bg-muted/35 p-3">
        <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{name}</span>
        <audio className="block w-full" controls onError={handleMediaError} preload="metadata" src={src} />
        {failed && <OpenMediaButton kind="audio" path={path} />}
      </span>
    )
  }

  if (kind === 'video' && src) {
    return (
      <span className="my-3 block max-w-2xl rounded-xl border border-border bg-muted/35 p-3">
        <span className="mb-2 block truncate text-xs font-medium text-muted-foreground">{name}</span>
        <video className="block max-h-112 w-full rounded-lg bg-black" controls onError={handleMediaError} src={src} />
        {failed && <OpenMediaButton kind="video" path={path} />}
      </span>
    )
  }

  return (
    <span className="wrap-anywhere">
      <a
        className="font-semibold text-foreground underline underline-offset-4 decoration-current/20 wrap-anywhere"
        href="#"
        onClick={event => {
          event.preventDefault()
          open()
        }}
      >
        {failed ? `Open ${name}` : `Loading ${name}...`}
      </a>
      {openFailed && <OpenMediaFailedNote name={name} />}
    </span>
  )
}

// `#media:` hrefs render as inline attachments; everything else routes through
// rich URL embeds / PrettyLink. (The link-preview TOGGLE for a settled reply is
// separate and lives on the message footer — see `PreviewAttachment`, wired in
// thread/assistant-message.tsx.)
function MarkdownLink({ children, className, href, ...props }: ComponentProps<'a'>) {
  const mediaPath = mediaPathFromMarkdownHref(href)

  if (mediaPath) {
    return <MediaAttachment path={mediaPath} />
  }

  const target = href ? normalizeExternalUrl(href) : href

  if (!target || !/^https?:\/\//i.test(target)) {
    return (
      <a
        className={cn(
          'font-semibold text-foreground underline underline-offset-4 decoration-current/20 wrap-anywhere',
          className
        )}
        href={href}
        onClick={event => {
          if (href) {
            event.preventDefault()
            void openExternalLink(href)
          }
        }}
        rel="noopener noreferrer"
        target="_blank"
        {...props}
      >
        {children}
      </a>
    )
  }

  const text = childrenToText(children)

  // Bare autolink → inline rich embed when a provider matches. Labeled links
  // (`[watch](url)`) stay plain. (Universal is a Tauri webview, so the iframe /
  // widget renderers can run — no desktop-webview gate.)
  if (text && normalizeExternalUrl(text) === target) {
    const embed = detectEmbed(target)

    if (embed) {
      return <UrlEmbed descriptor={embed} />
    }
  }

  const fallbackLabel = text && normalizeExternalUrl(text) !== target ? text : undefined

  return (
    <PrettyLink className={cn('wrap-anywhere', className)} fallbackLabel={fallbackLabel} href={target} {...props} />
  )
}

function MarkdownImage({ className, src, alt, ...props }: ComponentProps<'img'>) {
  // Rendered images (data:/http/gateway) open in the shared pan/zoom viewer.
  // `#media:` hrefs (incl. file:// media) are dispatched by MarkdownLink →
  // MediaAttachment, which resolves gateway bytes to a data URL and renders
  // here with a real src.
  if (!src) {
    return null
  }

  return (
    <ZoomableImage
      alt={typeof alt === 'string' ? alt : ''}
      className={cn(
        'm-0 block h-auto w-auto max-h-(--image-preview-height) max-w-[min(100%,var(--image-preview-max-width))] rounded-lg object-contain',
        className
      )}
      src={typeof src === 'string' ? src : ''}
      {...props}
    />
  )
}

interface MarkdownTextSurfaceProps {
  containerClassName?: string
  containerProps?: ComponentProps<'div'>
  defer?: boolean
}

// Headings shrink to chat scale rather than the prose default (h1≈xl).
const HEADING_SIZES: Record<'h1' | 'h2' | 'h3' | 'h4', string> = {
  h1: 'text-[1rem] tracking-tight',
  h2: 'text-[0.9375rem] tracking-tight',
  h3: 'text-[0.875rem]',
  h4: 'text-[0.8125rem]'
}

const MARKDOWN_CONTAINER_CLASS_NAME = cn(
  'aui-md prose w-full max-w-none overflow-hidden text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height) text-foreground',
  'prose-p:leading-(--dt-line-height) prose-li:leading-(--dt-line-height)',
  'prose-headings:text-foreground prose-strong:text-foreground',
  'prose-a:break-words prose-p:[overflow-wrap:anywhere]',
  'prose-li:marker:text-muted-foreground/70',
  'prose-code:rounded-[0.25rem] prose-code:px-[0.1875rem] prose-code:py-px prose-code:font-mono prose-code:text-[0.9em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>*+*]:mt-(--paragraph-gap)'
)

const MAX_MARKDOWN_CHARS = 200_000

function HugeTextFallback({ containerClassName, text }: { containerClassName?: string; text: string }) {
  const chunks = useMemo(() => chunkByLines(text, 200), [text])

  return (
    <div
      className={cn(
        'aui-md w-full max-w-none overflow-hidden rounded-[0.625rem] border border-border font-mono text-[0.7rem] leading-relaxed text-foreground/90',
        containerClassName
      )}
    >
      <ExpandableBlock className="p-2">
        {chunks.map((chunk, index) => (
          <div
            className="[content-visibility:auto]"
            key={index}
            style={{ containIntrinsicSize: `auto ${chunk.lines * 16}px` }}
          >
            {chunk.text}
          </div>
        ))}
      </ExpandableBlock>
    </div>
  )
}

// ```mermaid / ```svg fences route to their lazy renderers; every other
// language falls back to the Shiki-highlighted code block.
//
// Reads the streaming flag from context rather than taking it as a prop, so the
// components map below can be a module constant. When this hung off the map and
// the map was memoized on `isStreaming`, a message finishing its stream changed
// this closure's identity — and streamdown's Block comparator does a per-KEY
// shallow compare of the components map, so EVERY block in the message
// re-parsed and re-rendered once at exactly the moment the transcript was
// heaviest. Same class of bug as the `components`/`loadingIndicator` literals
// fixed in thread.tsx.
function MarkdownSyntaxHighlighter(props: SyntaxHighlighterProps) {
  // Select the BOOLEAN, not the part. `useMessagePartText()` returns `s.part`,
  // which is a fresh object every token — subscribing to it here would
  // re-render every code block on every token of a streaming message, and a
  // store-driven re-render starts AT the subscribed component, so streamdown's
  // Block memo above can't stop it. Selecting a primitive means Object.is
  // compares equal until the run actually starts or ends.
  const isStreaming = useAuiState(state => state.part.status?.type === 'running')

  return (
    <RichCodeBlock
      code={props.code}
      fallback={<SyntaxHighlighter {...props} defer={isStreaming} />}
      language={props.language}
      streaming={isStreaming}
    />
  )
}

// Code parsing stays enabled while streaming so incomplete fences still render
// as code cards; the Shiki pass is deferred by SyntaxHighlighter instead.
// Module scope, like the components map, so the prop identity never changes.
const MARKDOWN_PLUGINS = { math: mathPlugin, code }

// `StreamdownTextComponents` is unsatisfiable by any object literal: it's an
// intersection of a `[key: string]: ComponentType<Record<string, unknown> &
// ExtraProps>` index signature with a `SyntaxHighlighter?:
// ComponentType<SyntaxHighlighterProps>` slot, and the named slot's props don't
// satisfy the library's own index signature. So the map is asserted through
// `unknown` — not to paper over a mistake of ours, but because the declared
// type contradicts itself.
//
// The same index signature also can't express that a custom tag receives its
// hast `node` (hast-util-to-jsx-runtime runs with `passNode: true`, which is how
// KatexHtml gets its markup) — hence the separate slot cast below.
type MarkdownComponentSlot = StreamdownTextComponents[string]

// Module constant — never re-created, so streamdown's per-key comparator always
// bails out. See MarkdownSyntaxHighlighter above for why this matters.
const MARKDOWN_COMPONENTS = {
  h1: ({ className, ...props }: ComponentProps<'h1'>) => (
    <h1 className={cn('my-1 font-semibold', HEADING_SIZES.h1, className)} {...props} />
  ),
  h2: ({ className, ...props }: ComponentProps<'h2'>) => (
    <h2 className={cn('my-1 font-semibold', HEADING_SIZES.h2, className)} {...props} />
  ),
  h3: ({ className, ...props }: ComponentProps<'h3'>) => (
    <h3 className={cn('my-1 font-semibold', HEADING_SIZES.h3, className)} {...props} />
  ),
  h4: ({ className, ...props }: ComponentProps<'h4'>) => (
    <h4 className={cn('my-1 font-semibold', HEADING_SIZES.h4, className)} {...props} />
  ),
  // Vertical rhythm owned by styles.css (`--paragraph-gap`) — no `my-*` here.
  p: ({ className, ...props }: ComponentProps<'p'>) => (
    <p className={cn('wrap-anywhere leading-(--dt-line-height)', className)} {...props} />
  ),
  a: MarkdownLink,
  inlineCode: ({ className, ...props }: ComponentProps<'code'>) => <code className={className} dir="ltr" {...props} />,
  // `---` as quiet spacing, not a heavy full-width rule.
  hr: (_props: ComponentProps<'hr'>) => <div aria-hidden className="my-3" />,
  // A `> [!NOTE]`/`[!WARNING]`/... blockquote renders as a GFM alert
  // callout; everything else stays a plain quote.
  blockquote: ({ children, className, ...props }: ComponentProps<'blockquote'>) => {
    const alert = extractAlert(children)

    if (alert) {
      return <MarkdownAlert type={alert.type}>{alert.body}</MarkdownAlert>
    }

    return (
      <blockquote
        className={cn('border-s-2 border-border ps-3 text-muted-foreground italic', className)}
        dir="auto"
        {...props}
      >
        {children}
      </blockquote>
    )
  },
  ul: ({ className, ...props }: ComponentProps<'ul'>) => (
    <ul className={cn('my-1 gap-0', className)} dir="auto" {...props} />
  ),
  ol: ({ className, ...props }: ComponentProps<'ol'>) => (
    <ol className={cn('my-1 gap-0', className)} dir="auto" {...props} />
  ),
  li: ({ className, ...props }: ComponentProps<'li'>) => (
    <li className={cn('leading-(--dt-line-height)', className)} {...props} />
  ),
  table: ({ className, ...props }: ComponentProps<'table'>) => (
    <div className="aui-md-table my-2 max-w-full overflow-x-auto rounded-[0.375rem] border border-border">
      <table
        className={cn(
          'm-0 w-full min-w-[18rem] border-collapse text-[0.8125rem] [&_tr]:border-b [&_tr]:border-border last:[&_tr]:border-0',
          className
        )}
        {...props}
      />
    </div>
  ),
  thead: ({ className, ...props }: ComponentProps<'thead'>) => (
    <thead className={cn('m-0 bg-muted/35 text-muted-foreground', className)} {...props} />
  ),
  th: ({ className, ...props }: ComponentProps<'th'>) => (
    <th
      className={cn(
        'whitespace-nowrap px-2.5 py-1.5 text-left align-middle text-[0.75rem] font-medium text-muted-foreground',
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }: ComponentProps<'td'>) => (
    <td className={cn('px-2.5 py-1.5 align-top text-[0.8125rem] leading-snug', className)} {...props} />
  ),
  img: MarkdownImage,
  // One entry per equation, emitted by the memoized math plugin.
  // hast-util-to-jsx-runtime resolves components by an exact
  // own-property lookup on tagName, so a custom tag routes here.
  [KATEX_HTML_TAG]: KatexHtml as unknown as MarkdownComponentSlot,
  SyntaxHighlighter: MarkdownSyntaxHighlighter
} as unknown as StreamdownTextComponents

function MarkdownTextSurface({ containerClassName, containerProps, defer }: MarkdownTextSurfaceProps) {
  const { text } = useMessagePartText()

  if (text.length > MAX_MARKDOWN_CHARS) {
    return <HugeTextFallback containerClassName={containerClassName} text={text} />
  }

  return (
    <StreamdownTextPrimitive
      components={MARKDOWN_COMPONENTS}
      containerClassName={cn(MARKDOWN_CONTAINER_CLASS_NAME, containerClassName)}
      containerProps={containerProps}
      defer={defer}
      lineNumbers={false}
      mode="streaming"
      parseIncompleteMarkdown={false}
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocksCached}
      plugins={MARKDOWN_PLUGINS}
      preprocess={preprocessWithTailRepair}
    />
  )
}

interface MarkdownTextContentProps extends MarkdownTextSurfaceProps {
  isRunning: boolean
  text: string
}

// Reasoning-text variant (no smoothing — matches the answer's plain append).
export function MarkdownTextContent({ isRunning, text, ...surfaceProps }: MarkdownTextContentProps) {
  return (
    <TextMessagePartProvider isRunning={isRunning} text={text}>
      <MarkdownTextSurface defer {...surfaceProps} />
    </TextMessagePartProvider>
  )
}

const MarkdownTextImpl = () => {
  return <MarkdownTextSurface defer />
}

export const MarkdownText = memo(MarkdownTextImpl)
