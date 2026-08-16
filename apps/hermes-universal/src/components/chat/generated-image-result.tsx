'use client'

import { type FC, useEffect, useState } from 'react'

import { ZoomableImage } from '@/components/chat/zoomable-image'
import { useI18n } from '@/i18n'
import { generatedImageFromResult } from '@/lib/generated-images'
import { resolveMediaDisplaySrc } from '@/lib/media'
import { cn } from '@/lib/utils'

// Ported (simplified) from apps/desktop/src/components/chat/generated-image-result.tsx.
//
// A generated image is written on the GATEWAY (~/.hermes/cache/images/…), so the
// source is resolved through `resolveMediaDisplaySrc` — the authenticated Rust
// transport — exactly like every other piece of gateway media. Pointing `<img>`
// at the raw /api/files/download URL instead is what made a successful
// generation render as NOTHING behind a gated gateway: the webview has no way to
// authenticate that request (`?token=` only exists in token mode, and the
// SameSite=Lax session cookie is never sent on a cross-site subresource), so it
// 401s, `onError` fires, and this component returns null on failure.
//
// Also simplified: the desktop diffusion-canvas placeholder + download/lightbox
// toolbar are replaced by a lightweight pulse placeholder and the shared
// click-to-zoom `ZoomableImage`.

const ASPECT_HINTS: Record<string, number> = {
  landscape: 16 / 9,
  square: 1,
  portrait: 9 / 16
}

function hintedRatio(aspectRatio?: string): number {
  return (
    ASPECT_HINTS[
      String(aspectRatio ?? '')
        .toLowerCase()
        .trim()
    ] ?? ASPECT_HINTS.landscape
  )
}

export const GeneratedImage: FC<{ aspectRatio?: string; result?: unknown }> = ({ aspectRatio, result }) => {
  const { t } = useI18n()
  const image = result === undefined ? null : generatedImageFromResult(result)
  const pending = result === undefined

  const [ratio, setRatio] = useState(() => hintedRatio(aspectRatio))
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [src, setSrc] = useState('')

  useEffect(() => setRatio(hintedRatio(aspectRatio)), [aspectRatio])

  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [image])

  // Resolving is a fetch over the transport, so the src arrives a tick late: keep
  // the pulse frame up until it does rather than flashing an empty box. A read
  // that throws is a real failure (the file is gone, or the gateway refused it),
  // which is the same outcome as an image that will not decode.
  useEffect(() => {
    if (!image) {
      setSrc('')

      return
    }

    let active = true
    setSrc('')

    void resolveMediaDisplaySrc(image)
      .then(resolved => {
        if (!active) {
          return
        }

        // A read that comes back empty is a failure that did not throw (the
        // gateway answered, with nothing). Without this the pulse frame would
        // spin forever — strictly worse than the honest "render nothing".
        if (resolved) {
          setSrc(resolved)
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true)
        }
      })

    return () => {
      active = false
    }
  }, [image])

  // Completed but no usable image (generation failed): the agent's prose carries
  // the explanation, so render nothing here.
  if (!pending && !image) {
    return null
  }

  if (failed) {
    return null
  }

  const frameStyle = {
    aspectRatio: ratio,
    width: `min(calc(var(--image-preview-height, 20rem) * ${ratio}), var(--image-preview-max-width, 32rem), 100%)`
  }

  // Pending (no source yet): a sized pulse frame so the resolved image lands in
  // the same box with no layout shift.
  if (!src) {
    return (
      <span
        aria-label={t.assistant.tool.renderingImage}
        aria-live="polite"
        className="block max-w-full animate-pulse overflow-hidden rounded-2xl bg-muted/60"
        data-slot="aui_generated-image"
        role="status"
        style={frameStyle}
      />
    )
  }

  return (
    <span
      className={cn(
        'block max-w-full overflow-hidden rounded-2xl transition-[background] duration-500',
        !loaded && 'animate-pulse bg-muted/60'
      )}
      data-slot="aui_generated-image"
      style={frameStyle}
    >
      <ZoomableImage
        alt="Generated image"
        className={cn(
          'size-full object-contain opacity-0 transition-opacity duration-500 ease-out',
          loaded && 'opacity-100'
        )}
        onError={() => setFailed(true)}
        onLoad={event => {
          const { naturalHeight, naturalWidth } = event.currentTarget

          if (naturalWidth && naturalHeight) {
            setRatio(naturalWidth / naturalHeight)
          }

          setLoaded(true)
        }}
        src={src}
      />
    </span>
  )
}
