import type { TextMessagePartComponent, TextMessagePartProps } from '@assistant-ui/react'
import type { FC } from 'react'
import { Fragment, useEffect, useMemo, useState } from 'react'

import { openSessionRef } from '@/app/open-session'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { Tip } from '@/components/ui/tooltip'
import { extractEmbeddedImages } from '@/lib/embedded-images'
import { openExternalLink } from '@/lib/external-link'
import { gatewayMediaDataUrl } from '@/lib/media'
import { useSessionLinkTitle } from '@/lib/session-link-title'
import { parseSessionRefValue } from '@/lib/session-refs'

import { hermesDirectiveFormatter, iconPathsFor, refAttrs, type SlashChipKind } from './directive-text'

// React renderer for Hermes directives in SENT user messages — the display
// half of the composer's directive pipeline (the parser/serializer/glyphs live
// in directive-text.ts; this file is kept separate to avoid a .ts/.tsx basename
// clash on the `directive-text` import specifier). Ported from the renderer half
// of apps/desktop/src/components/assistant-ui/directive-text.tsx.

/** The glyph for a reference kind. Size, spacing, and opacity come from the
 *  `.ref > svg` rules — the icon only has to say which shape it is. */
const DirectiveIcon: FC<{ type: string }> = ({ type }) => (
  <svg
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    {iconPathsFor(type).map(d => (
      <path d={d} key={d} />
    ))}
  </svg>
)

function safeEmbeddedImages(text: string) {
  try {
    return extractEmbeddedImages(text)
  } catch {
    return { cleanedText: text, images: [] as string[] }
  }
}

function safeDirectiveSegments(text: string) {
  try {
    return [...hermesDirectiveFormatter.parse(text)]
  } catch {
    return [{ kind: 'text' as const, text }]
  }
}

/**
 * Renders text containing Hermes directives (`@file:...`, `@image:...`) as
 * inline chips. Embedded MEDIA images render below as a thumbnail row.
 */
export function DirectiveContent({ text }: { text: string }) {
  const { cleanedText, images } = useMemo(() => safeEmbeddedImages(text ?? ''), [text])
  const segments = useMemo(() => safeDirectiveSegments(cleanedText), [cleanedText])

  return (
    <span className="whitespace-pre-line" data-slot="aui_directive-text">
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <Fragment key={`t-${index}`}>{segment.text}</Fragment>
        ) : segment.type === 'image' ? (
          <DirectiveImage id={segment.id} key={`img-${index}-${segment.id}`} label={segment.label} />
        ) : segment.type === 'session' ? (
          <SessionChip id={segment.id} key={`s-${index}-${segment.id}`} label={segment.label} />
        ) : segment.type === 'skill' ? (
          <SlashChip key={`m-${index}-${segment.id}`} kind="skill" label={segment.label} value={segment.id} />
        ) : (
          <DirectiveChip id={segment.id} key={`m-${index}-${segment.id}`} label={segment.label} type={segment.type} />
        )
      )}
      {images.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-2" data-slot="aui_embedded-images">
          {images.map((src, index) => (
            <ZoomableImage
              alt=""
              className="max-h-48 max-w-full rounded-lg border border-(--ui-stroke-tertiary) object-contain"
              draggable={false}
              key={`img-${index}`}
              slot="aui_embedded-image"
              src={src}
            />
          ))}
        </span>
      )}
    </span>
  )
}

/** assistant-ui adapter: same renderer, exposed as a TextMessagePartComponent. */
export const DirectiveText: TextMessagePartComponent = ({ text }: TextMessagePartProps) => (
  <DirectiveContent text={text ?? ''} />
)

/** Image refs render as a thumbnail rather than a chip — matches how persisted
 * messages render after the backend embeds the data URL, so the UX is stable
 * across initial send and refresh. */
const DirectiveImage: FC<{ id: string; label: string }> = ({ id, label }) => {
  const isUrl = /^(?:https?|data):/i.test(id)
  const [src, setSrc] = useState<string | null>(isUrl ? id : null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (isUrl || !id) {
      return
    }

    let alive = true

    // The image lives on the gateway's disk, not ours — fetch it over the
    // authenticated fs bridge as a data URL.
    void gatewayMediaDataUrl(id)
      .then(url => alive && url && setSrc(url))
      .catch(() => alive && setFailed(true))

    return () => {
      alive = false
    }
  }, [id, isUrl])

  if (failed) {
    return <DirectiveChip id={id} label={label} type="image" />
  }

  if (!src) {
    return (
      <span
        aria-hidden
        className="inline-block size-12 shrink-0 animate-pulse rounded-md bg-[color-mix(in_srgb,currentColor_8%,transparent)]"
      />
    )
  }

  return (
    <ZoomableImage
      alt={label}
      className="max-h-32 max-w-48 rounded-md border border-(--ui-stroke-tertiary) object-contain"
      draggable={false}
      slot="aui_directive-image"
      src={src}
    />
  )
}

/** A skill referenced inside a sent message — the rendered twin of the
 *  composer's slash pill, so a picked skill stays a reference after send
 *  instead of flattening back to `/work` as raw text. */
const SlashChip: FC<{ kind: SlashChipKind; label: string; value: string }> = ({ kind, label, value }) => (
  <span {...refAttrs(kind)} data-slot="aui_slash-chip" title={value}>
    <DirectiveIcon type={kind} />
    {label}
  </span>
)

/**
 * A directive reference in a sent message. Now that it renders as a link rather
 * than a badge, a kind that names something openable has to actually open it —
 * a `@url:` that reads as a link and does nothing is worse than the inert pill
 * it replaced. `url` is the one kind here (`session` has its own chip above,
 * which needs the async navigator); everything else is inert text.
 *
 * The kind → action table stays out of this file on purpose: desktop shares one
 * with the composer's hover pill, universal keeps the composer's copy local so
 * `directive-text.ts` — which the rich editor imports on its hot path — never
 * drags `external-link`/`open-session` in behind it.
 */
const DirectiveChip: FC<{
  type: string
  label: string
  id: string
}> = ({ type, label, id }) => {
  const activate = type === 'url' ? () => void openExternalLink(id) : undefined

  const props = {
    ...refAttrs(type, activate ? 'wrap-anywhere cursor-pointer' : 'wrap-anywhere'),
    'data-directive-id': id,
    'data-directive-type': type,
    'data-slot': 'aui_directive-chip',
    title: id
  }

  const body = (
    <>
      <DirectiveIcon type={type} />
      {label}
    </>
  )

  return activate ? (
    <button {...props} onClick={activate} type="button">
      {body}
    </button>
  ) : (
    <span {...props}>{body}</span>
  )
}

/**
 * A `@session:` ref in a SENT USER message — the one directive kind that names
 * something you can GO to.
 *
 * The chip resolves its own title (`lib/session-link-title`, which dedupes N
 * chips for one session down to one lookup) and opens the conversation on
 * click, fronting it if it is already on screen.
 *
 * The intent is `tab`, never `in-place`, with or without a modifier: the chip
 * sits INSIDE a conversation the user is reading, which may itself be mid-turn.
 * Loading the linked session into the main pane would yank that chat out from
 * under them — the exact case `openSessionRef`'s own doc-comment reserves `tab`
 * for. (Desktop's `SessionRefChip` hard-codes the same intent.)
 */
const SessionChip: FC<{ id: string; label: string }> = ({ id, label }) => {
  const title = useSessionLinkTitle(id, label)
  const { sessionId } = parseSessionRefValue(id)

  return (
    <Tip label={id}>
      <button
        {...refAttrs('session', 'wrap-anywhere cursor-pointer')}
        data-directive-id={id}
        data-directive-type="session"
        data-slot="aui_directive-chip"
        onClick={() => openSessionRef(sessionId, 'tab')}
        type="button"
      >
        <DirectiveIcon type="session" />
        {title}
      </button>
    </Tip>
  )
}

/**
 * A `@session:` ref the AGENT wrote, inside markdown prose.
 *
 * This is the half the feature exists for: `session_search` hands the model a
 * `@session:<profile>/<id>` link and instructs it to use the link as a noun
 * mid-sentence (`tools/session_search_tool.py`). An assistant turn renders as
 * MARKDOWN, not as directive segments, so `DirectiveContent` above never sees
 * it — the ref arrives here as a `#session/` href that `preprocessMarkdown`
 * rewrote (`lib/session-refs.ts#linkifySessionRefs`) and `MarkdownLink`
 * dispatched.
 *
 * An inline link rather than a chip because the agent wrote it as part of a
 * sentence; a block-ish pill mid-paragraph reads as an interruption.
 */
export const SessionRefLink: FC<{ label?: string; value: string }> = ({ label, value }) => {
  const title = useSessionLinkTitle(value, label)
  const { sessionId } = parseSessionRefValue(value)

  return (
    <Tip label={value}>
      <a
        {...refAttrs('session', 'wrap-anywhere cursor-pointer')}
        data-directive-id={value}
        data-directive-type="session"
        data-slot="aui_session-ref-link"
        href="#"
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          openSessionRef(sessionId, 'tab')
        }}
      >
        <DirectiveIcon type="session" />
        {title}
      </a>
    </Tip>
  )
}
