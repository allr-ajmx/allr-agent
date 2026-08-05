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
 * The markers worth naming, MOST SPECIFIC FIRST — the order is the whole point.
 *
 * `data-slot` is a shadcn convention scattered across generic wrappers, so the
 * NEAREST identifying ancestor is usually the least informative one. Asking for
 * each marker in turn, over the whole chain, is what makes a sash read as a
 * sash instead of as whatever generic wrapper happens to sit closest to it.
 */
const MARKERS = ['[role="separator"]', '[data-tree-tab]', '[data-tree-group]', '[data-tree-split]', '[data-slot]']

/**
 * A short, stable description of what was interacted with.
 *
 * The event target is almost never the interesting element. The 384ms
 * `pointerdown` that started this was reported against a bare `span` — the 1px
 * hairline inside a sash — and against bare `div`s for every zone in the tree,
 * because the old version only asked the target ITSELF for `data-slot` or
 * `data-tree-split`. A trace naming thirteen different anonymous `div`s cannot
 * tell you which one to look at.
 *
 * Deliberately structural — a marker, a tag, a pane-id PREFIX — and never text
 * content, a value, or an id. Two rules follow from that, and both are load
 * bearing:
 *
 *  - `data-tree-tab` carries the pane id, which for a chat is
 *    `session-tile:<sessionId>` — a user identifier. Only the prefix ships.
 *    Static pane ids (`workspace`, `files`, `terminal`) have no colon and are
 *    registered names, so they ride along whole.
 *  - Generated node ids (`data-tree-group`, `data-tree-split`) are recorded as
 *    the MARKER only. They churn per session, so as tag values they would be
 *    unsearchable in Jaeger while telling you nothing the marker does not.
 *
 * Two empty answers, kept distinct: `unknown` means there was no element to
 * describe (the observer runs after the fact; the node may be detached by
 * then), while `div?` means an element was found and nothing on its chain
 * identified it. Collapsing those into one string is precisely the
 * convincingly-empty result this whole layer exists to avoid — the first is an
 * instrument with nothing to measure, the second is a gap in the markers.
 *
 * SHIPS, and the cost is five native `closest()` calls — walked in C++, not JS,
 * and only for entries that already passed the 16ms threshold. An explicit
 * ancestor loop with a hop limit would be slower than the thing it bounds.
 *
 * Exported for the test: the observer itself cannot be exercised (see the
 * synthetic-click note above), so this is the only piece of the module a unit
 * test can reach.
 */
export function describeTarget(target: Node | null | undefined): string {
  if (!target || !(target instanceof Element)) {
    return 'unknown'
  }

  const tag = target.tagName.toLowerCase()

  for (const marker of MARKERS) {
    const found = target.closest(marker)

    if (!found) {
      continue
    }

    if (marker === '[role="separator"]') {
      return `${tag}[sash]`
    }

    if (marker === '[data-tree-tab]') {
      const pane = found.getAttribute('data-tree-tab') ?? ''

      return `${tag}[tab:${pane.split(':')[0]}]`
    }

    if (marker === '[data-slot]') {
      return `${tag}[${found.getAttribute('data-slot')}]`
    }

    return `${tag}[${marker === '[data-tree-group]' ? 'zone' : 'split'}]`
  }

  return `${tag}?`
}

/**
 * How many frames an interaction's window covered, when the frame clock is
 * running. Injected rather than imported: this module SHIPS and `frames.ts` is
 * dev/bench only, so a static import would drag the frame clock into the
 * release bundle to answer a question nobody there can ask.
 *
 * It resolves the fork an `interaction` span cannot: 384ms of presentation is a
 * completely different bug depending on whether it was one enormous frame or
 * twenty-three dropped ones, and nothing in the Event Timing entry says which.
 */
let frameCounter: ((startMs: number, endMs: number) => number) | null = null

export function setFrameCounter(fn: typeof frameCounter): void {
  frameCounter = fn
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

      const end = entry.startTime + entry.duration
      const frames = frameCounter?.(entry.startTime, end)

      recordSpan('interaction', entry.startTime, end, {
        // Named so the three phases read as durations in Jaeger's tag list
        // without anyone having to subtract timestamps by hand.
        inputDelayMs: Math.round(entry.processingStart - entry.startTime),
        presentationMs: Math.round(end - entry.processingEnd),
        processingMs: Math.round(entry.processingEnd - entry.processingStart),
        target: describeTarget(entry.target),
        type: entry.name,
        ...(frames === undefined ? {} : { frames })
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
