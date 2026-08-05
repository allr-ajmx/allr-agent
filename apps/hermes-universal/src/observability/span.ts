/**
 * Span recording — the core of the observability layer.
 *
 * WHAT THIS IS FOR
 *
 * A span records when an operation started, when it ended, and what it was
 * nested inside. One interaction therefore becomes a waterfall rather than a
 * bag of durations, and the quantity that falls out of the waterfall is the one
 * worth having: `gapMs`, the time inside a span that NO child accounts for.
 *
 * That number is why this exists instead of a histogram. Chasing a slow pane
 * drag, every individual measurement looked healthy — React commits summed to
 * 768ms of 5167ms, forced style+layout to 14ms, the drag callback to 6ms — and
 * the aggregate could not express the only interesting fact, which was "and
 * then nothing we measure happened for 200ms". A gap is not a stage; it is the
 * ABSENCE of one, and no histogram has a bucket for it. Spans do.
 *
 * ONE RUN, NOT MANY. Percentiles over 500 samples describe a distribution but
 * cannot say that on frame 41 a store write fanned out into a 180ms commit that
 * then blocked the next four frames. Causality only survives in a single trace,
 * so this keeps whole runs and exports them rather than folding them into
 * moments.
 *
 * COST WHEN OFF
 *
 * Recording is off by default and this module ships in release builds, so
 * "off" has to be genuinely free: every entry point early-returns on one
 * boolean. That is the whole prod cost — no allocation, no timestamp, no work.
 * Enabling it is an explicit act (a console call today; a Diagnostics toggle
 * later), which is what makes it safe to have a user turn on while reproducing
 * a bug and hand back the result.
 *
 * CLOCK CAVEAT
 *
 * WebKitGTK clamps `performance.now()` to 1ms, so spans shorter than that
 * report 0 and boundaries land on tick edges. At frame scale (16ms+) that is
 * immaterial — which is the scale this is for. Do not read a sub-millisecond
 * span duration as anything but noise.
 */

/**
 * Spans retained per run. A 10-second drag at 60fps with a handful of spans per
 * frame fits comfortably; a streaming session with store autocapture will hit
 * it, which is what the noise floor in `auto/stores.ts` exists to prevent.
 */
const CAPACITY = 8192

/** Sentinel returned when not recording. `endSpan` ignores it. */
export const NO_SPAN = -1

let recording = false

export function isRecording(): boolean {
  return recording
}

/**
 * Turn recording on or off. Off also clears, so a session never accumulates a
 * stale prefix from before someone started paying attention.
 */
export function setRecording(on: boolean): void {
  recording = on

  if (!on) {
    clearSpans()
  }
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

// ─── Storage ────────────────────────────────────────────────────────────────
//
// Numbers live in preallocated typed arrays and names are interned. The reason
// is not micro-optimisation: at 60fps x N spans, an object per span allocates
// fast enough that GC pauses land INSIDE the frames being measured, and the
// tracer starts reporting its own overhead as render cost.

const names: string[] = []
const nameIds = new Map<string, number>()
const spanName = new Int32Array(CAPACITY)
const spanParent = new Int32Array(CAPACITY)
const spanStart = new Float64Array(CAPACITY)
const spanEnd = new Float64Array(CAPACITY)
/**
 * Which trace each span belongs to. A root span takes the next trace number; a
 * child copies its parent's. See `nextTrace` for why this is not derived from
 * the span's index.
 */
const spanTrace = new Float64Array(CAPACITY)
/** Sparse — only spans actually given attributes appear here. */
const spanAttrs = new Map<number, SpanAttrs>()

let count = 0
/**
 * Monotonic across the whole page — and deliberately NOT reset by `clearSpans`.
 *
 * Trace ids used to be derived from the root span's INDEX, which broke as soon
 * as the exporter started draining: `clearSpans` sets `count = 0`, so root index
 * 0 in one flush window and root index 0 in the next produced the same trace id
 * (and the same span ids). Jaeger keys on trace id, so unrelated interactions
 * silently merged into one trace, and a long operation spanning many drains
 * could attach its children to whatever trace later occupied the same index.
 *
 * A counter that survives the drain fixes it: identity comes from when a trace
 * STARTED, not from where its span happens to sit in the current buffer.
 */
let traceCounter = 0
/** Open spans, innermost last. Gives each new span its parent. */
const stack: number[] = []

export type SpanAttrs = Record<string, number | string>

/**
 * The trace number for a span with the given parent: a new one for a root,
 * otherwise the parent's. Called once per span, on the hot path, so it stays a
 * single array read rather than a walk to the root.
 */
function traceFor(parent: number): number {
  return parent === -1 ? (traceCounter += 1) : spanTrace[parent]
}

function intern(name: string): number {
  const existing = nameIds.get(name)

  if (existing !== undefined) {
    return existing
  }

  const id = names.length

  names.push(name)
  nameIds.set(name, id)

  return id
}

// ─── Recording ──────────────────────────────────────────────────────────────

/**
 * Open a span. The returned id must be passed to `endSpan`.
 *
 * Overflow DROPS new spans rather than wrapping. A ring buffer would leave
 * spans whose parents had been overwritten by their own children, which renders
 * as a corrupt waterfall — strictly worse to read than an honestly truncated
 * one, because it looks plausible.
 */
export function beginSpan(name: string, attrs?: SpanAttrs): number {
  if (!recording || count >= CAPACITY) {
    return NO_SPAN
  }

  const id = count++
  const parent = stack.length > 0 ? stack[stack.length - 1] : -1

  spanName[id] = intern(name)
  spanParent[id] = parent
  spanTrace[id] = traceFor(parent)
  spanStart[id] = now()
  spanEnd[id] = NaN

  if (attrs) {
    spanAttrs.set(id, attrs)
  }

  stack.push(id)

  return id
}

export function endSpan(id: number, attrs?: SpanAttrs): void {
  if (id === NO_SPAN) {
    return
  }

  spanEnd[id] = now()

  if (attrs) {
    spanAttrs.set(id, { ...spanAttrs.get(id), ...attrs })
  }

  // Unwind TO this span, tolerating an unbalanced end. Spans wrap callbacks
  // that can throw or be abandoned mid-gesture, and one leaked frame span must
  // not silently reparent the entire rest of the run underneath itself.
  const at = stack.lastIndexOf(id)

  if (at !== -1) {
    stack.length = at
  }
}

/**
 * Record an ALREADY-FINISHED span from timestamps handed to you.
 *
 * For work that reports itself after the fact — React's Profiler and the
 * PerformanceObserver entries are both like this. They fire once the work is
 * complete and supply its real start and end, so a begin/end pair here would
 * record a zero-length span at the wrong point in the waterfall.
 */
export function recordSpan(name: string, startMs: number, endMs: number, attrs?: SpanAttrs): void {
  if (!recording || count >= CAPACITY) {
    return
  }

  const id = count++
  const parent = stack.length > 0 ? stack[stack.length - 1] : -1

  spanName[id] = intern(name)
  spanParent[id] = parent
  spanTrace[id] = traceFor(parent)
  spanStart[id] = startMs
  spanEnd[id] = endMs

  if (attrs) {
    spanAttrs.set(id, attrs)
  }
}

/** Span a synchronous call. Returns whatever `fn` returns, always. */
export function span<T>(name: string, fn: () => T, attrs?: SpanAttrs): T {
  if (!recording) {
    return fn()
  }

  const id = beginSpan(name, attrs)

  try {
    return fn()
  } finally {
    endSpan(id)
  }
}

export function clearSpans(): void {
  count = 0
  stack.length = 0
  spanAttrs.clear()
}

/** True when no span is open — the only safe moment to drain the buffer. */
export function isIdle(): boolean {
  return stack.length === 0
}

export function spanCount(): number {
  return count
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface TraceSpan {
  attrs?: SpanAttrs
  depth: number
  durationMs: number
  /** Time inside this span covered by NO child — the residue that matters. */
  gapMs: number
  id: number
  name: string
  parent: number
  startMs: number
}

/**
 * Time within `id` that none of its direct children cover.
 *
 * This is the number the module exists to produce. A frame span of 200ms whose
 * children sum to 20ms says the other 180ms went somewhere with no
 * instrumentation in it — engine style/layout/paint, or a genuinely idle main
 * thread — and which of those it is decides what to fix.
 *
 * Overlapping children are merged before subtracting, so two concurrent
 * children cannot be counted twice and drive the gap negative.
 */
function selfGap(id: number): number {
  const ranges: [number, number][] = []

  for (let i = 0; i < count; i += 1) {
    if (spanParent[i] === id && !Number.isNaN(spanEnd[i])) {
      ranges.push([spanStart[i], spanEnd[i]])
    }
  }

  ranges.sort((a, b) => a[0] - b[0])

  let covered = 0
  let cursor = spanStart[id]

  for (const [from, to] of ranges) {
    const start = Math.max(from, cursor)

    if (to > start) {
      covered += to - start
      cursor = to
    }
  }

  const end = Number.isNaN(spanEnd[id]) ? spanStart[id] : spanEnd[id]

  return Math.max(0, end - spanStart[id] - covered)
}

function depthOf(id: number): number {
  let depth = 0
  let cursor = spanParent[id]

  // Bounded: a cycle would otherwise hang the reader, and this runs on a
  // buffer that unbalanced ends can in principle scramble.
  while (cursor !== -1 && depth < 64) {
    depth += 1
    cursor = spanParent[cursor]
  }

  return depth
}

/**
 * Which trace this span belongs to. One trace per interaction.
 *
 * Replaces an earlier `rootOf(id)` walk: keying on the root's INDEX looked
 * equivalent and was not, because indices are recycled by `clearSpans` while
 * traces are not. See `traceCounter`.
 */
export function traceOf(id: number): number {
  return spanTrace[id]
}

export function spans(): TraceSpan[] {
  const out: TraceSpan[] = []

  for (let i = 0; i < count; i += 1) {
    const end = Number.isNaN(spanEnd[i]) ? spanStart[i] : spanEnd[i]

    out.push({
      attrs: spanAttrs.get(i),
      depth: depthOf(i),
      durationMs: end - spanStart[i],
      gapMs: selfGap(i),
      id: i,
      name: names[spanName[i]],
      parent: spanParent[i],
      startMs: spanStart[i]
    })
  }

  return out
}
