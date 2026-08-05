/**
 * Interaction latency, captured by the engine — no code in any interaction path.
 *
 * This is the highest-leverage piece of the whole layer, and it is entirely
 * free: the browser already measures every interaction and will hand them over
 * for the asking. Each `event` entry decomposes into the three phases that
 * actually matter, and the arithmetic is the same decomposition an
 * investigation into a janky pane drag spent days rebuilding by hand:
 *
 *   startTime ──▶ processingStart   INPUT DELAY
 *                                   the thread was busy; the handler had not
 *                                   started yet. Someone else's work.
 *   processingStart ──▶ processingEnd   PROCESSING
 *                                   our listeners. The only part our code owns
 *                                   directly.
 *   processingEnd ──▶ startTime+duration   PRESENTATION
 *                                   render, style, layout, paint. Where a
 *                                   "cheap handler" that dirties the whole tree
 *                                   shows its real cost.
 *
 * A drag whose handler measures 1ms and whose presentation measures 180ms is a
 * completely different bug from one where processing is 180ms, and no amount of
 * wrapping the handler in a timer distinguishes them. This does, for every
 * interaction, forever, without anyone deciding in advance where to look.
 *
 * ENGINE SUPPORT, verified on WebKitGTK 2.52.3 (what Tauri embeds on Linux):
 * `event` and `first-input` are available, along with `paint`, `navigation`,
 * `resource` and `largest-contentful-paint`, and `observe()` accepts
 * `durationThreshold`. NOT available: `longtask`, `layout-shift`,
 * `long-animation-frame`. So nothing here may depend on a Chromium-only entry
 * type, and frame pacing needs a different instrument.
 *
 * TESTING NOTE, learned by writing the test first: a synthetic `el.click()`
 * produces NO entry. Event Timing measures real user interactions, and an
 * untrusted event is excluded by spec — so this cannot be exercised from a unit
 * test or a scripted harness, and an empty result there is correct behaviour
 * rather than a broken observer. Verify it with an actual pointer.
 */

import { recordSpan } from '../span'

/**
 * Ignore anything under one frame. An interaction that resolves inside the
 * budget is not a problem, and recording every hover would bury the ones that
 * are. 16ms is also the documented floor for `durationThreshold` — asking for
 * less does not get you less.
 */
const DURATION_THRESHOLD_MS = 16

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number
  processingEnd: number
  processingStart: number
  target?: Node | null
}

/**
 * TypeScript's DOM lib predates Event Timing, so `PerformanceObserverInit` has
 * no `durationThreshold`. Dropping it would silently change behaviour — the
 * observer would report every interaction rather than the slow ones — so widen
 * the type rather than the filter.
 */
interface EventTimingObserverInit extends PerformanceObserverInit {
  durationThreshold?: number
}

/**
 * A short, stable description of what was interacted with.
 *
 * Deliberately structural — tag, `data-slot`, or a pane/test id — and never text
 * content or a value. Span attributes can end up in a bug report or a shared
 * trace, and user content must not ride along in them.
 */
function describeTarget(target: Node | null | undefined): string {
  if (!target || !(target instanceof Element)) {
    return 'unknown'
  }

  const slot = target.getAttribute('data-slot') ?? target.getAttribute('data-tree-split')
  const tag = target.tagName.toLowerCase()

  return slot ? `${tag}[${slot}]` : tag
}

export function installEventTiming(): () => void {
  if (typeof PerformanceObserver === 'undefined') {
    return () => {}
  }

  // Feature-detect rather than try/catch alone: an unsupported entry type makes
  // observe() throw, and on a WebKit build without Event Timing that would take
  // out whatever else ran in the same install step.
  const supported = PerformanceObserver.supportedEntryTypes ?? []

  if (!supported.includes('event')) {
    return () => {}
  }

  const observer = new PerformanceObserver(list => {
    for (const raw of list.getEntries()) {
      const entry = raw as EventTimingEntry

      recordSpan('interaction', entry.startTime, entry.startTime + entry.duration, {
        // Named so the three phases read as durations in Jaeger's tag list
        // without anyone having to subtract timestamps by hand.
        inputDelayMs: Math.round(entry.processingStart - entry.startTime),
        presentationMs: Math.round(entry.startTime + entry.duration - entry.processingEnd),
        processingMs: Math.round(entry.processingEnd - entry.processingStart),
        target: describeTarget(entry.target),
        type: entry.name
      })
    }
  })

  try {
    // `buffered` picks up interactions that happened before this installed —
    // notably during boot, which is precisely when nobody has had a chance to
    // start recording yet.
    const init: EventTimingObserverInit = {
      buffered: true,
      durationThreshold: DURATION_THRESHOLD_MS,
      type: 'event'
    }

    observer.observe(init)
  } catch {
    return () => {}
  }

  return () => observer.disconnect()
}
