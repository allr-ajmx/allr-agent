/**
 * The frame clock — one `requestAnimationFrame` loop for the whole app, and the
 * span that everything happening inside a frame hangs from.
 *
 * WHY THIS EXISTS AT ALL
 *
 * WebKitGTK 2.52.3 has no `long-animation-frame` and no `longtask` entry type,
 * so the one thing the engine will tell us about a slow frame is the opaque
 * `presentationMs` on an `interaction`. In the capture that motivated this, a
 * hover cost 750ms of presentation against 2ms of processing — the handlers
 * were innocent and there was no instrument that could say what the other 748ms
 * was. This is that instrument's spine.
 *
 * rAF→rAF IS PACING, NOT WORK — the mistake this module is shaped to avoid
 *
 * The obvious design is to bracket rAF #N to rAF #N+1 and call that "the
 * frame". It is wrong, and wrong in the most expensive direction: an idle app
 * reports ~16ms per frame with ~0ms of children, which reads as 16ms of
 * uninstrumented engine work when it is 16ms of nothing. `gapMs` — the number
 * span.ts exists to produce — would become noise everywhere.
 *
 * So four numbers, deliberately distinct:
 *
 *   sinceLastMs  rAF → rAF. PACING. Includes idle. What the FPS HUD plots.
 *   rafMs        our callback's own duration. JS inside the rendering step.
 *   activeMs     rAF start → post-paint task. The WORK window.
 *   paintEstimateMs
 *                activeMs − rafMs − work reported by children. The residual:
 *                paint and compositing. Named `…Estimate` because it is a
 *                subtraction, not a measurement, and nobody may read it as one.
 *
 * THE POST-PAINT BOUNDARY
 *
 * `activeMs` needs a callback that runs after the rendering update. A
 * `MessageChannel` message posted from inside the rAF callback is the standard
 * way to get one — `setTimeout` is clamped and ordered behind timers, so it
 * would report a floor rather than a boundary. This ordering is NOT verified on
 * WebKitGTK; see TRACING.md for the check (dirty a large layout inside the rAF
 * callback and confirm `activeMs` grows while `rafMs` stays flat). Until that
 * check is on record, trust `layout.forced` over `activeMs`.
 *
 * LAZY SPANS
 *
 * `currentFrame()` allocates the `frame` span on first ask, so a frame in which
 * nothing happened produces no span at all. That is the design and not an
 * optimisation: idle costs nothing, reads as nothing, and the span volume of a
 * long capture stays proportional to the work rather than to the wall clock.
 *
 * THE COST IT CANNOT AVOID
 *
 * A running rAF loop keeps the compositor awake, so the app never idles while
 * this is on — the same cost `dev/fps-hud.ts` documents about itself, and the
 * reason the loop runs only while someone is actually looking (recording, or
 * the FPS HUD visible) rather than for every dev session. An instrument that
 * changes the app under test in every build is worse than one you have to
 * switch on.
 *
 * DEV/BENCH ONLY, installed from observability/install.ts.
 */

import { LONG_FRAME_MS } from '@/dev/frame-meter'

import { captureRoot, endSpan, isRecording, NO_SPAN, openSpan, recordSpan } from '../span'

/** Frame windows kept for `framesIn`. Matches FrameMeter's ring. */
const HISTORY = 120

type FrameFn = (deltaMs: number, atMs: number) => void
type FrameEndFn = (frameSerial: number, atMs: number) => void

const frameFns = new Set<FrameFn>()
const frameEndFns = new Set<FrameEndFn>()
/** Who currently wants frames. The loop runs while this is non-empty. */
const wanters = new Set<string>()

let raf = 0
let installed = false

let lastRafAt = 0
let frameOpenedAt = 0
let rafEndedAt = 0
let sinceLastMs = 0
/** JS other instruments have attributed to THIS frame (see `noteFrameWork`). */
let reportedWorkMs = 0
let frameSerial = NO_SPAN

/** Ring of [startMs, endMs] frame windows. */
const history: number[] = []

let channel: MessageChannel | null = null

const now = (): number => performance.now()

/**
 * The span for the frame currently being rendered, allocated on first ask.
 *
 * Children pass this to `recordSpan`'s explicit `parent` rather than relying on
 * the synchronous stack: they run on later tasks than the rAF callback, so the
 * stack cannot hold it, and an ambient default would sweep every websocket
 * frame and streaming store write of the same window underneath it too.
 */
export function currentFrame(): number {
  if (!isRecording() || frameOpenedAt === 0) {
    return NO_SPAN
  }

  if (frameSerial === NO_SPAN) {
    frameSerial = openSpan('frame', frameOpenedAt, captureRoot().serial)
  }

  return frameSerial
}

/**
 * Attribute `ms` of measured JS to the current frame, so `paintEstimateMs` can
 * subtract it. Called by the instruments that know their own cost — the engine
 * probe with style+layout, the React profiler with `actualDuration`.
 */
export function noteFrameWork(ms: number): void {
  reportedWorkMs += ms
}

/** How many frames overlapped `[startMs, endMs]` — "one huge frame, or twenty
 *  dropped ones?", which an `interaction` span alone cannot answer. */
export function framesIn(startMs: number, endMs: number): number {
  let n = 0

  for (let i = 0; i < history.length; i += 2) {
    if (history[i] < endMs && history[i + 1] > startMs) {
      n += 1
    }
  }

  return n
}

/** Subscribe to frame PACING (the FPS HUD's meter). Returns an unsubscribe. */
export function onFrame(fn: FrameFn): () => void {
  frameFns.add(fn)

  return () => frameFns.delete(fn)
}

/** Subscribe to the post-paint boundary — the moment a frame's work is done and
 *  its span is about to close. Where per-frame accumulators flush. */
export function onFrameEnd(fn: FrameEndFn): () => void {
  frameEndFns.add(fn)

  return () => frameEndFns.delete(fn)
}

function closeFrame(): void {
  if (frameOpenedAt === 0) {
    return
  }

  const at = now()

  // Subscribers run FIRST: a counter flush may be the thing that decides this
  // frame had work worth a span at all, via currentFrame().
  for (const fn of frameEndFns) {
    fn(frameSerial, at)
  }

  const activeMs = at - frameOpenedAt
  const rafMs = rafEndedAt - frameOpenedAt

  if (frameSerial !== NO_SPAN) {
    endSpan(frameSerial, {
      activeMs: Math.round(activeMs),
      paintEstimateMs: Math.round(Math.max(0, activeMs - rafMs - reportedWorkMs)),
      rafMs: Math.round(rafMs),
      sinceLastMs: Math.round(sinceLastMs)
    })
  } else if (sinceLastMs >= LONG_FRAME_MS) {
    // A long frame with NO instrumented work in it. Deliberately a different
    // name: it means "the engine, or genuinely idle", which is a different
    // finding from a slow frame of ours and must not be averaged in with one.
    recordSpan('frame.stall', frameOpenedAt, frameOpenedAt + sinceLastMs, { sinceLastMs: Math.round(sinceLastMs) })
  }

  history.push(frameOpenedAt, at)

  if (history.length > HISTORY * 2) {
    history.splice(0, history.length - HISTORY * 2)
  }

  frameSerial = NO_SPAN
  frameOpenedAt = 0
  reportedWorkMs = 0
}

function tick(): void {
  // `performance.now()`, not the rAF argument: the argument is the frame's
  // target timestamp, which on a dropped frame is a time already in the past.
  const at = now()

  // Defensive: if the post-paint message never arrived (a backgrounded tab
  // parks it), close the previous frame here rather than leaking an open span
  // and mis-parenting everything that follows into it.
  closeFrame()

  sinceLastMs = lastRafAt === 0 ? 0 : at - lastRafAt
  lastRafAt = at
  frameOpenedAt = at

  for (const fn of frameFns) {
    fn(sinceLastMs, at)
  }

  rafEndedAt = now()
  channel?.port2.postMessage(0)

  raf = requestAnimationFrame(tick)
}

function sync(): void {
  const wanted = wanters.size > 0 && !(typeof document !== 'undefined' && document.hidden)

  if (wanted && raf === 0) {
    // Zero, not `now()`: the first callback would otherwise be measured against
    // this instant rather than against a previous frame.
    lastRafAt = 0
    raf = requestAnimationFrame(tick)

    return
  }

  if (!wanted && raf !== 0) {
    cancelAnimationFrame(raf)
    raf = 0
    closeFrame()
    lastRafAt = 0
  }
}

/**
 * Declare that `source` does or does not need frames right now. The loop runs
 * while at least one source wants it — today the FPS HUD (while visible) and
 * the tracer (while recording).
 */
export function setFramesActive(source: string, on: boolean): void {
  if (on) {
    wanters.add(source)
  } else {
    wanters.delete(source)
  }

  sync()
}

export function installFrames(): () => void {
  if (installed || typeof window === 'undefined') {
    return () => {}
  }

  installed = true

  if (typeof MessageChannel !== 'undefined') {
    channel = new MessageChannel()
    channel.port1.onmessage = closeFrame
    channel.port1.start()
  }

  document.addEventListener('visibilitychange', sync)

  return () => {
    document.removeEventListener('visibilitychange', sync)
    wanters.clear()
    sync()
    channel?.port1.close()
    channel?.port2.close()
    channel = null
    installed = false
  }
}
