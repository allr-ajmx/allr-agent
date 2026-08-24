import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { useResizeObserver } from '@/hooks/use-resize-observer'
import { $composerPoppedOut } from '@/store/composer-popout'
import { isSecondaryWindow } from '@/store/windows'

interface UseComposerMetricsArgs {
  composerRef: RefObject<HTMLFormElement | null>
  composerSurfaceRef: RefObject<HTMLDivElement | null>
  editorRef: RefObject<HTMLDivElement | null>
  poppedOut: boolean
}

/**
 * Publishes the composer's measured height to the CSS vars the thread reads for
 * bottom clearance. All work is edge-gated: the ResizeObserver only fires on
 * real size changes, and the heights are 8px-bucketed so per-keystroke growth
 * never invalidates the tree's computed style.
 *
 * This hook used to ALSO own a layout decision — a width ladder
 * (`stacked` / `compactPill`) that put the controls on their own row below a
 * certain width and otherwise inlined them beside the input. That ladder is
 * gone: the composer is now two rows everywhere, so the same bar appears in the
 * chat screen, on a phone and in the HUD instead of three arrangements the
 * viewport picked between. See the grid in `index.tsx`.
 */
export function useComposerMetrics({
  composerRef,
  composerSurfaceRef,
  editorRef,
  poppedOut
}: UseComposerMetricsArgs): void {
  // Bucket measured heights so we only invalidate the global CSS var when
  // the size crosses a meaningful threshold. Without bucketing, the editor
  // grows ~1px per character → setProperty fires every keystroke → entire
  // tree's computed style is invalidated → next paint forces a full
  // recalculate-style pass. With an 8px bucket, the invalidation rate drops
  // ~8× and small char-by-char typing produces no style invalidation at all
  // until a wrap or row change actually happens.
  const lastBucketedHeightRef = useRef(0)
  const lastBucketedSurfaceHeightRef = useRef(0)
  // The element the vars were last written to, so unmount clears the same one.
  const hostRef = useRef<HTMLElement | null>(null)

  // WHERE the measured vars live: this composer's OWN chat root, not the
  // document. They used to go on `<html>`, which was fine while one chat was on
  // screen and wrong the moment tiles arrived — every open chat ran this hook
  // against the same two variables, so the last one to measure won and every
  // other tile sized its transcript from a stranger's composer.
  //
  // `.chat` (styles.css) is where `--thread-viewport-height` is declared, so a
  // value written here re-substitutes for this tile and inherits no further.
  // Falling back to the document keeps the single-surface paths (mobile, a
  // secondary window) behaving exactly as before.
  const metricsHost = (composer: HTMLElement): HTMLElement =>
    composer.closest<HTMLElement>('.chat') ?? document.documentElement

  const syncComposerMetrics = useCallback(() => {
    const composer = composerRef.current

    if (!composer) {
      return
    }

    hostRef.current = metricsHost(composer)

    // Floating composer is out of the thread's flow — it must not reserve any
    // bottom clearance. Zero the measured vars so the thread reclaims the space.
    // (Read globals here so the callback stays stable; mirror the popoutAllowed
    // gate since secondary windows are forced docked.)
    if ($composerPoppedOut.get() && !isSecondaryWindow()) {
      const root = hostRef.current ?? document.documentElement
      lastBucketedHeightRef.current = 0
      lastBucketedSurfaceHeightRef.current = 0
      root.style.setProperty('--composer-measured-height', '0px')
      root.style.setProperty('--composer-surface-measured-height', '0px')

      return
    }

    const { height } = composer.getBoundingClientRect()
    const surfaceHeight = composerSurfaceRef.current?.getBoundingClientRect().height
    const root = hostRef.current ?? document.documentElement

    if (height > 0) {
      const bucket = Math.ceil(height / 8) * 8

      if (bucket !== lastBucketedHeightRef.current) {
        lastBucketedHeightRef.current = bucket
        root.style.setProperty('--composer-measured-height', `${bucket}px`)
      }
    }

    if (surfaceHeight && surfaceHeight > 0) {
      const bucket = Math.ceil(surfaceHeight / 8) * 8

      if (bucket !== lastBucketedSurfaceHeightRef.current) {
        lastBucketedSurfaceHeightRef.current = bucket
        root.style.setProperty('--composer-surface-measured-height', `${bucket}px`)
      }
    }
  }, [composerRef, composerSurfaceRef])

  // MEASURE ONCE, SYNCHRONOUSLY, ON MOUNT — before the browser paints.
  //
  // The observer's first delivery is same-frame and pre-paint, but only for the
  // frame the OBSERVER starts in, and the thread has already laid itself out
  // against `--composer-fallback-height` by then. Any difference between the
  // fallback and the real height is a shift the user sees on every chat open:
  // the transcript renders, then jumps as the real number lands.
  //
  // A layout effect here reads a dirty layout and forces one reflow, which the
  // shared observer's comment warns about at length — that warning is about
  // MANY elements (a bubble each, a hundred of them on a session switch). This
  // is ONE element, once per mount, and it buys an exact first paint. The
  // fallback still exists for the frame before this runs and for surfaces that
  // never mount a composer.
  useLayoutEffect(() => {
    syncComposerMetrics()
  }, [syncComposerMetrics])

  // `editorRef` is observed but never read: the editor growing a line is what
  // changes the composer's height, and the observer is how that reaches the
  // measurement above.
  useResizeObserver(syncComposerMetrics, composerRef, composerSurfaceRef, editorRef)

  // Toggling pop-out changes whether the composer reserves thread clearance.
  // The ResizeObserver may not fire (the box can keep the same box size), so
  // re-sync explicitly: docked republishes the measured height, floating zeroes
  // it so the thread reclaims the bottom space.
  useEffect(() => {
    syncComposerMetrics()
  }, [poppedOut, syncComposerMetrics])

  useEffect(() => {
    return () => {
      // The element we actually wrote to — by unmount the composer ref is
      // already null, so clearing `.chat` by lookup would find nothing and
      // leave a dead override behind on a kept-alive tile.
      const root = hostRef.current

      root?.style.removeProperty('--composer-measured-height')
      root?.style.removeProperty('--composer-surface-measured-height')
      hostRef.current = null
    }
  }, [])
}
