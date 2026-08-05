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
 * ONE CAPTURE, ONE TRACE
 *
 * Everything recorded between `setRecording(true)` and `setRecording(false)`
 * belongs to a single trace, hung off a single `capture` root span.
 *
 * The first version instead made every span with an empty stack a ROOT, and
 * minted a trace id per root. That reads as reasonable and is catastrophic in
 * practice, because *every* seam in this app is entered from a fresh task —
 * a PerformanceObserver callback, a Tauri event listener, a React render, an
 * await continuation — at which point the stack is always empty. So every span
 * was a root: one session produced 573 traces, essentially all of them a single
 * span, and nothing nested inside anything. `gapMs` had nothing to subtract
 * from and Jaeger had nothing to draw.
 *
 * Hence `currentParent()`: the synchronous stack when there is one, and the
 * capture root otherwise. A span with no discoverable parent is not evidence
 * that a new trace started — it is evidence that the work was scheduled, which
 * is the normal case in a browser.
 *
 * IDENTITY IS A SERIAL, NOT A BUFFER INDEX
 *
 * Spans are addressed by a monotonic serial that no drain resets, and a parent
 * is stored as its parent's SERIAL. That is what lets a trace outlive a flush:
 * the exporter ships completed spans every couple of seconds and compacts the
 * buffer, and a child recorded three drains after its parent still points at
 * the right span. With indices it could not — `clearSpans` recycles them, so a
 * long operation (an SSH connect runs 45–90s, roughly 45 drains) would graft
 * its later spans onto whatever unrelated span had inherited the index.
 *
 * COST WHEN OFF
 *
 * Recording is off by default and this module ships in release builds, so
 * "off" has to be genuinely free: every entry point early-returns on one
 * boolean. That is the whole prod cost — no allocation, no timestamp, no work.
 * Enabling it is an explicit act (the dev HUD, or `__hermesTrace.on()`), which
 * is what makes it safe to have a user turn on while reproducing a bug and hand
 * back the result.
 *
 * CLOCK CAVEAT
 *
 * WebKitGTK clamps `performance.now()` to 1ms, so spans shorter than that
 * report 0 and boundaries land on tick edges. At frame scale (16ms+) that is
 * immaterial — which is the scale this is for. Do not read a sub-millisecond
 * span duration as anything but noise.
 */

/**
 * Spans held between drains.
 *
 * This used to have to cover a whole capture, because a drain destroyed the
 * buffer's parent relationships and so could only happen between interactions.
 * It now only has to cover one drain interval (2s) plus whatever is still open,
 * so the same number is comfortable rather than tight.
 *
 * Overflow still DROPS rather than wraps — see `beginSpan`.
 */
const CAPACITY = 8192

/**
 * How long one capture may run before it is rolled into a fresh trace.
 *
 * One trace per capture is what makes a waterfall readable, but it has a
 * failure mode: someone turns recording on, forgets, and comes back to a trace
 * with a quarter million spans that Jaeger will not open. Rolling puts a
 * ceiling on that at the cost of a seam every ten minutes, which is a much
 * better trade than an unopenable trace.
 */
const DEFAULT_MAX_CAPTURE_MS = 10 * 60 * 1000

/**
 * Sentinel returned when not recording. `endSpan` ignores it.
 *
 * 0 rather than -1 because serials start at 1 — and because OTLP already
 * reserves an all-zero span id as "none", so the two agree.
 */
export const NO_SPAN = 0

let recording = false

export function isRecording(): boolean {
  return recording
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
/** This span's stable identity. Survives every drain. */
const spanSerial = new Float64Array(CAPACITY)
/** The PARENT'S serial, not its buffer index. 0 means no parent. */
const spanParent = new Float64Array(CAPACITY)
const spanStart = new Float64Array(CAPACITY)
const spanEnd = new Float64Array(CAPACITY)
/**
 * Which capture (trace) each span belongs to. Normally the current one — the
 * column exists so that spans recorded either side of a capture roll do not get
 * merged into whichever trace happens to be open at export time.
 */
const spanTrace = new Float64Array(CAPACITY)
/**
 * 1 when this span was pushed onto the synchronous stack, so `endSpan` knows
 * whether to unwind. Detached spans (see `beginDetached`) never are.
 */
const spanStacked = new Uint8Array(CAPACITY)
/** Sparse — only spans actually given attributes appear here, keyed by index. */
const spanAttrs = new Map<number, SpanAttrs>()

let count = 0

/**
 * Monotonic span identity. Deliberately NOT reset by `clearSpans` — that is the
 * entire point; see the module comment.
 */
let serialCounter = 0
/** Monotonic capture identity, which becomes the trace id. Also never reset. */
let captureCounter = 0

/** Open spans (stack-pushed ones only), innermost last. Holds buffer indices. */
const stack: number[] = []

/**
 * Serial → buffer index, for spans opened by `beginSpan`/`beginDetached` and not
 * yet ended.
 *
 * Only OPEN spans are in here, so it stays the size of the nesting depth plus
 * whatever async work is in flight — a handful of entries, not thousands. That
 * is what makes a Map affordable on a path this hot: `recordSpan`, which is the
 * high-volume entry point, never touches it.
 */
const openIndex = new Map<number, number>()

export type SpanAttrs = Record<string, number | string>

// ─── Capture lifecycle ──────────────────────────────────────────────────────

/** The root span every other span in a capture hangs from. */
export interface CaptureRoot {
  attrs?: SpanAttrs
  /** Absent while the capture is still open. */
  endMs?: number
  name: string
  serial: number
  startMs: number
  trace: number
}

let captureTrace = 0
let captureRootSerial = 0
let captureName = 'capture'
let captureAttrs: SpanAttrs | undefined
let captureStart = 0
let captureEnd: number | undefined
let maxCaptureMs = DEFAULT_MAX_CAPTURE_MS

function openCapture(label?: string): void {
  captureCounter += 1
  serialCounter += 1

  captureTrace = captureCounter
  captureRootSerial = serialCounter
  captureName = label ? `capture ${label}` : 'capture'
  captureAttrs = label ? { run: label } : undefined
  captureStart = now()
  captureEnd = undefined
}

/**
 * Turn recording on or off.
 *
 * Turning ON clears whatever was left in the buffer and opens a fresh capture,
 * so a session never accumulates a stale prefix from before someone started
 * paying attention.
 *
 * Turning OFF stamps the capture root's end but deliberately does NOT clear:
 * the spans are the thing being collected, and the exporter still has to ship
 * them. It calls `clearSpans` once the final flush is away.
 */
export function setRecording(on: boolean, label?: string): void {
  if (on) {
    clearSpans()
    openCapture(label)
    recording = true

    return
  }

  if (recording) {
    captureEnd = now()
  }

  recording = false
}

/**
 * Roll into a fresh capture if this one has run past its ceiling.
 *
 * Called from the exporter's drain rather than from the recording path: it is a
 * clock comparison that only needs to be right within a couple of seconds, and
 * the drain already runs on that cadence. Keeping it off `beginSpan` keeps the
 * hot path at one boolean.
 *
 * Returns the closed capture root when it rolls, so the caller can ship it.
 */
export function rollCaptureIfStale(): CaptureRoot | null {
  if (!recording || now() - captureStart < maxCaptureMs) {
    return null
  }

  captureEnd = now()

  const closed = captureRoot()

  rootTaken = closed.serial
  openCapture(captureAttrs?.run as string | undefined)

  return closed
}

let rootTaken = 0

/**
 * The capture root, once, and only once the capture has closed.
 *
 * A root span can only be sent with its real end time, which is not known until
 * recording stops — so between start and stop the trace is deliberately
 * ROOTLESS in Jaeger. It is browsable that way, just missing its top bar, and
 * it completes the moment the capture does. The alternative, re-sending the
 * root on every drain with a provisional end, leaves Jaeger holding a dozen
 * copies of one span id.
 */
export function takeCaptureRoot(): CaptureRoot | null {
  if (captureEnd === undefined || rootTaken === captureRootSerial) {
    return null
  }

  rootTaken = captureRootSerial

  return captureRoot()
}

export function setMaxCaptureMs(ms: number): void {
  maxCaptureMs = ms
}

/** The current capture's root span. Its `endMs` is absent until recording stops. */
export function captureRoot(): CaptureRoot {
  return {
    attrs: captureAttrs,
    endMs: captureEnd,
    name: captureName,
    serial: captureRootSerial,
    startMs: captureStart,
    trace: captureTrace
  }
}

/** True once recording has stopped and the root is ready to be exported. */
export function isCaptureClosed(): boolean {
  return captureEnd !== undefined
}

// ─── Recording ──────────────────────────────────────────────────────────────

/**
 * The serial a new span should hang from: the innermost open span, or the
 * capture root when nothing is open.
 *
 * The fallback is the whole fix. Returning "no parent" here is what turned
 * every scheduled callback into its own trace.
 */
function currentParent(): number {
  return stack.length > 0 ? spanSerial[stack[stack.length - 1]] : captureRootSerial
}

/** A trace context, for handing to something that runs off this thread. */
export interface SpanContext {
  serial: number
  trace: number
}

/**
 * The trace and span this call is running inside, or null when not recording.
 *
 * Used to propagate context across the IPC boundary: the invoke wrapper turns
 * this into a `traceparent` header and the Rust backend picks it up as a remote
 * parent, so a command's spans land inside the frontend span that caused them
 * instead of in a trace of their own.
 */
export function currentContext(): SpanContext | null {
  if (!recording) {
    return null
  }

  return { serial: currentParent(), trace: captureTrace }
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

/** Write the shared columns for a new span and return its buffer index. */
function alloc(name: string, parent: number, startMs: number, endMs: number, attrs?: SpanAttrs): number {
  const index = count++

  serialCounter += 1

  spanName[index] = intern(name)
  spanSerial[index] = serialCounter
  spanParent[index] = parent
  spanTrace[index] = captureTrace
  spanStart[index] = startMs
  spanEnd[index] = endMs
  spanStacked[index] = 0

  if (attrs) {
    spanAttrs.set(index, attrs)
  }

  return index
}

/**
 * Open a span. The returned serial must be passed to `endSpan`.
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

  const index = alloc(name, currentParent(), now(), NaN, attrs)

  spanStacked[index] = 1
  stack.push(index)
  openIndex.set(spanSerial[index], index)

  return spanSerial[index]
}

/**
 * Open a span off the synchronous stack, with an EXPLICIT start time and
 * parent. The returned serial must be passed to `endSpan`.
 *
 * For work whose window is known before its children are: a frame is the case
 * that forced this. A frame's children — the React commit, the forced-layout
 * probe, the counter flush — are recorded from LATER tasks, so they cannot
 * find the frame on the stack and cannot be swept under it by an ambient
 * default either (that would also swallow every websocket frame and streaming
 * store write that happened to land in the same window, and `gapMs` is exactly
 * the number such a mis-parenting destroys). They reference its serial
 * directly instead, which keeps parenting opt-in per call site.
 *
 * `startMs` is explicit for the other half of the same problem: a frame span
 * that started when its first child asked would render children beginning
 * before their own parent, and a waterfall that cannot be true is worse than
 * no waterfall.
 */
export function openSpan(name: string, startMs: number, parent: number, attrs?: SpanAttrs): number {
  if (!recording || count >= CAPACITY) {
    return NO_SPAN
  }

  const index = alloc(name, parent, startMs, NaN, attrs)

  openIndex.set(spanSerial[index], index)

  return spanSerial[index]
}

/**
 * Open a span that does NOT join the synchronous stack.
 *
 * For work that spans an `await`. A synchronous LIFO and an async operation are
 * incompatible: `http.request` used to sit on the stack for the whole round
 * trip, so every unrelated span opened while a request was in flight became its
 * child, and closing it truncated the stack out from under spans that were
 * legitimately open. Capturing the parent at call time and staying off the
 * stack gets the parentage right without corrupting anyone else's.
 */
export function beginDetached(name: string, attrs?: SpanAttrs): number {
  return openSpan(name, now(), currentParent(), attrs)
}

export function endSpan(serial: number, attrs?: SpanAttrs): void {
  if (serial === NO_SPAN) {
    return
  }

  const index = openIndex.get(serial)

  if (index === undefined) {
    // Already ended, or drained away underneath us. Either way there is nothing
    // to close and nothing worth complaining about.
    return
  }

  spanEnd[index] = now()
  openIndex.delete(serial)

  if (attrs) {
    spanAttrs.set(index, { ...spanAttrs.get(index), ...attrs })
  }

  if (!spanStacked[index]) {
    return
  }

  // Unwind TO this span, tolerating an unbalanced end. Spans wrap callbacks
  // that can throw or be abandoned mid-gesture, and one leaked frame span must
  // not silently reparent the entire rest of the run underneath itself.
  const at = stack.lastIndexOf(index)

  if (at !== -1) {
    stack.length = at
  }
}

/**
 * Record an ALREADY-FINISHED span from timestamps handed to you.
 *
 * For work that reports itself after the fact — the PerformanceObserver entries
 * and react-shiki's highlight completion are both like this. They fire once the
 * work is complete and supply its real start and end, so a begin/end pair here
 * would record a zero-length span at the wrong point in the waterfall.
 *
 * `parent` is explicit for exactly that reason: a late report arrives on some
 * unrelated task, so "whatever is on the stack right now" is the wrong answer
 * whenever the caller knows better.
 */
export function recordSpan(name: string, startMs: number, endMs: number, attrs?: SpanAttrs, parent?: number): void {
  if (!recording || count >= CAPACITY) {
    return
  }

  alloc(name, parent ?? currentParent(), startMs, endMs, attrs)
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

/**
 * Span an async call. The span is detached, so concurrent work is not swept
 * underneath it and its completion cannot truncate anyone else's stack.
 */
export async function spanAsync<T>(name: string, fn: () => Promise<T>, attrs?: SpanAttrs): Promise<T> {
  if (!recording) {
    return fn()
  }

  const id = beginDetached(name, attrs)

  try {
    const result = await fn()

    endSpan(id)

    return result
  } catch (error) {
    // Close it before rethrowing, and mark it — a failed operation that simply
    // vanished from the trace is worse than no instrumentation, because the gap
    // it leaves looks like idle time.
    endSpan(id, { error: 'true' })

    throw error
  }
}

export function clearSpans(): void {
  count = 0
  stack.length = 0
  spanAttrs.clear()
  openIndex.clear()
}

/** True when no span is open. */
export function isIdle(): boolean {
  return stack.length === 0
}

export function spanCount(): number {
  return count
}

/** How deep the synchronous stack is right now — a live readout for the HUD. */
export function openSpanCount(): number {
  return stack.length
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** A span as the exporter sees it: flat, no derived analysis. */
export interface ExportSpan {
  attrs?: SpanAttrs
  endMs: number
  name: string
  /** Parent's serial, or 0 for none. */
  parent: number
  serial: number
  startMs: number
  trace: number
}

export interface TraceSpan extends ExportSpan {
  depth: number
  durationMs: number
  /** Time inside this span covered by NO child — the residue that matters. */
  gapMs: number
}

function read(index: number): ExportSpan {
  return {
    attrs: spanAttrs.get(index),
    endMs: spanEnd[index],
    name: names[spanName[index]],
    parent: spanParent[index],
    serial: spanSerial[index],
    startMs: spanStart[index],
    trace: spanTrace[index]
  }
}

/**
 * Take every FINISHED span out of the buffer, leaving the open ones in place.
 *
 * This is what makes a capture longer than one flush interval possible. The
 * open spans are compacted to the front and the stack rewritten to their new
 * indices; because children reference a parent's SERIAL rather than its slot,
 * everything recorded after this still resolves to the right parent — including
 * spans whose parent left in an earlier batch.
 */
export function takeCompleted(): ExportSpan[] {
  const batch: ExportSpan[] = []
  const keptAttrs = new Map<number, SpanAttrs>()
  let kept = 0

  for (let i = 0; i < count; i += 1) {
    if (!Number.isNaN(spanEnd[i])) {
      batch.push(read(i))

      continue
    }

    const to = kept

    kept += 1

    const attrs = spanAttrs.get(i)

    if (attrs) {
      keptAttrs.set(to, attrs)
    }

    if (to === i) {
      continue
    }

    spanName[to] = spanName[i]
    spanSerial[to] = spanSerial[i]
    spanParent[to] = spanParent[i]
    spanTrace[to] = spanTrace[i]
    spanStart[to] = spanStart[i]
    spanEnd[to] = spanEnd[i]
    spanStacked[to] = spanStacked[i]

    // Detached spans are open but never on the stack, hence the guard.
    const at = stack.indexOf(i)

    if (at !== -1) {
      stack[at] = to
    }

    openIndex.set(spanSerial[to], to)
  }

  count = kept
  spanAttrs.clear()

  for (const [index, attrs] of keptAttrs) {
    spanAttrs.set(index, attrs)
  }

  return batch
}

/** Everything currently held, without disturbing the buffer. */
export function peekAll(): ExportSpan[] {
  const out: ExportSpan[] = []

  for (let i = 0; i < count; i += 1) {
    out.push(read(i))
  }

  return out
}

/**
 * Time within a span that none of its direct children cover.
 *
 * This is the number the module exists to produce. A frame span of 200ms whose
 * children sum to 20ms says the other 180ms went somewhere with no
 * instrumentation in it — engine style/layout/paint, or a genuinely idle main
 * thread — and which of those it is decides what to fix.
 *
 * Overlapping children are merged before subtracting, so two concurrent
 * children cannot be counted twice and drive the gap negative.
 */
function selfGap(startMs: number, endMs: number, children: ExportSpan[]): number {
  const ranges = children
    .filter(child => !Number.isNaN(child.endMs))
    .map(child => [child.startMs, child.endMs] as const)
    .sort((a, b) => a[0] - b[0])

  let covered = 0
  let cursor = startMs

  for (const [from, to] of ranges) {
    const start = Math.max(from, cursor)

    if (to > start) {
      covered += to - start
      cursor = to
    }
  }

  return Math.max(0, endMs - startMs - covered)
}

/**
 * The console reader: every held span with its depth and its gap.
 *
 * Kept separate from `takeCompleted` because the two want different things.
 * The exporter wants a flat batch as cheaply as possible every two seconds;
 * this wants derived analysis, once, when a human asks. Computing the analysis
 * on the export path made every drain O(n²) — `selfGap` scanned the whole
 * buffer per span — for numbers nothing on that path reads.
 */
export function spans(): TraceSpan[] {
  const all = peekAll()
  const bySerial = new Map<number, ExportSpan>()
  const children = new Map<number, ExportSpan[]>()

  for (const s of all) {
    bySerial.set(s.serial, s)

    const siblings = children.get(s.parent)

    if (siblings) {
      siblings.push(s)
    } else {
      children.set(s.parent, [s])
    }
  }

  const depthOf = (s: ExportSpan): number => {
    let depth = 0
    let cursor = bySerial.get(s.parent)

    // Bounded: a cycle would otherwise hang the reader, and this runs on a
    // buffer that unbalanced ends can in principle scramble. A parent that
    // drained in an earlier batch simply stops the walk — the span is shown at
    // the depth its still-present ancestry implies.
    while (cursor && depth < 64) {
      depth += 1
      cursor = bySerial.get(cursor.parent)
    }

    return depth
  }

  return all.map(s => {
    const end = Number.isNaN(s.endMs) ? s.startMs : s.endMs

    return {
      ...s,
      depth: depthOf(s),
      durationMs: end - s.startMs,
      gapMs: selfGap(s.startMs, end, children.get(s.serial) ?? [])
    }
  })
}
