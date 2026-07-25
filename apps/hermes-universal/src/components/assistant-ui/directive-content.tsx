import type { TextMessagePartComponent, TextMessagePartProps } from '@assistant-ui/react'
import type { FC } from 'react'
import { Fragment, useEffect, useMemo, useState } from 'react'

import { ZoomableImage } from '@/components/chat/zoomable-image'
import { extractEmbeddedImages } from '@/lib/embedded-images'
import { gatewayMediaDataUrl } from '@/lib/media'

import { DIRECTIVE_CHIP_CLASS, hermesDirectiveFormatter, iconPathsFor } from './directive-text'

// React renderer for Hermes directives in SENT user messages — the display
// half of the composer's directive pipeline (the parser/serializer/glyphs live
// in directive-text.ts; this file is kept separate to avoid a .ts/.tsx basename
// clash on the `directive-text` import specifier). Ported from the renderer half
// of apps/desktop/src/components/assistant-ui/directive-text.tsx.

const DirectiveIcon: FC<{ type: string }> = ({ type }) => (
  <svg
    className="size-3 shrink-0 opacity-80"
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
        ) : (
          <DirectiveChip id={segment.id} key={`m-${index}-${segment.id}`} label={segment.label} type={segment.type} />
        )
      )}
      {images.length > 0 && (
        <span className="mt-2 flex flex-wrap gap-2" data-slot="aui_embedded-images">
          {images.map((src, index) => (
            <ZoomableImage
              alt=""
              className="max-h-48 max-w-full rounded-lg border border-border/60 object-contain"
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
      className="max-h-32 max-w-48 rounded-md border border-border/40 object-contain"
      draggable={false}
      slot="aui_directive-image"
      src={src}
    />
  )
}

const DirectiveChip: FC<{
  type: string
  label: string
  id: string
}> = ({ type, label, id }) => (
  <span
    className={DIRECTIVE_CHIP_CLASS}
    data-directive-id={id}
    data-directive-type={type}
    data-slot="aui_directive-chip"
    title={id}
  >
    <DirectiveIcon type={type} />
    <span className="truncate">{label}</span>
  </span>
)
