/**
 * The engine probe — the only instrument here that can say "the layout engine
 * is not your bug."
 *
 * THE PROBLEM IT SOLVES
 *
 * Every span in this app measures JavaScript. The capture that motivated this
 * work had 138 interactions totalling 9.7 seconds in which `processingMs` was
 * ~0 and `presentationMs` was everything — a hover costing 750ms with 2ms of
 * handler. All of that time is inside WebKit's style/layout/paint pipeline,
 * where no JS span can reach, and the engine will not decompose it for us:
 * WebKitGTK 2.52.3 has no `long-animation-frame` and no `longtask`.
 *
 * THE TRICK
 *
 * Force the two phases from JS, one at a time, and time the forcing:
 *
 *   getComputedStyle(...)  flushes pending STYLE recalculation
 *   offsetHeight           flushes pending LAYOUT
 *
 * Reading them in that order attributes each phase separately, which is the
 * fork the whole investigation turns on. A hover costing 58ms with 2ms of
 * processing is the signature of a document-wide STYLE recalc — and if that is
 * what this reports, then the layout-tree walk everyone suspected is a red
 * herring and the fix is CSS. An instrument that could only confirm the
 * layout-engine hypothesis would eventually "confirm" it whether or not it was
 * true, because it would be the only thing measured.
 *
 * TWO PROBE SITES, AND WHY THE SECOND ONE EXISTS
 *
 *  - `commit`    — at the end of every layout-tree commit, while the DOM is
 *                  still dirty from it.
 *  - `pre-frame` — at the top of each rAF. `pane-shell/geometry.ts` writes
 *                  `--workspace-left/right` on `:root` from a post-layout
 *                  ResizeObserver callback, which re-dirties style for
 *                  everything that reads those custom properties. That is a
 *                  SECOND style+layout pass in the same frame, and the
 *                  commit-time probe is structurally unable to see it. A
 *                  consistently non-zero reading here is a finding in itself.
 *
 * TWO WAYS THIS LIES, BOTH ON THE RECORD
 *
 * 1. It MOVES cost rather than revealing it. Forced layout is real work pulled
 *    earlier in the frame; the total is roughly conserved but redistributed.
 *    Frame durations measured with the probe installed are not comparable to
 *    frame durations measured without it.
 * 2. `styleMs` may be a fiction. If WebKit folds style recalculation into the
 *    layout flush, this will read 0 forever and `layoutMs` will silently carry
 *    both. Verify by hand before building a conclusion on the split — toggle a
 *    class on `<html>` and confirm `styleMs` moves while `layoutMs` does not,
 *    then change a width and confirm the reverse. TRACING.md carries the
 *    result.
 *
 * DEV/BENCH ONLY.
 */

import { setLayoutCommitHook } from '@/components/pane-shell/tree/renderer/telemetry'

import { isRecording, recordSpan } from '../span'

import { currentFrame, noteFrameWork, onFrame } from './frames'

/**
 * WebKitGTK clamps `performance.now()` to 1ms, so anything below this is
 * indistinguishable from zero and recording it would bury the frames where the
 * engine actually did something. Same floor, same reason, as `auto/stores.ts`.
 */
const NOISE_FLOOR_MS = 1

export function probeEngine(reason: 'commit' | 'pre-frame'): void {
  if (!isRecording() || typeof document === 'undefined') {
    return
  }

  const root = document.documentElement

  const t0 = performance.now()
  // Reading any computed property flushes pending style; `color` is inherited
  // and always present, so it cannot be optimised away as unused.
  const flushed = getComputedStyle(root).color
  const t1 = performance.now()
  // A geometry read forces layout. Kept separate from the style read above so
  // the two phases can be told apart.
  const height = root.offsetHeight
  const t2 = performance.now()

  // Both values are consumed so no engine or bundler can elide the reads that
  // ARE the measurement.
  if (flushed === '\0' && height < 0) {
    return
  }

  noteFrameWork(t2 - t0)

  if (t2 - t0 < NOISE_FLOOR_MS) {
    return
  }

  recordSpan(
    'layout.forced',
    t0,
    t2,
    { layoutMs: Math.round(t2 - t1), reason, styleMs: Math.round(t1 - t0) },
    currentFrame() || undefined
  )
}

export function installEngineProbe(): () => void {
  setLayoutCommitHook(() => probeEngine('commit'))

  const off = onFrame(() => probeEngine('pre-frame'))

  return () => {
    off()
    setLayoutCommitHook(null)
  }
}
