/**
 * Ship spans to a local OpenTelemetry collector, and expose the tracer's
 * controls to the console and the dev HUD.
 *
 * DEV/BENCH ONLY. `toOtlp()` next door ships in release because a bug report
 * needs serialisation; this file does not, because a release build must never
 * hold a hardcoded collector URL or make an unsolicited outbound request. The
 * split is the whole reason they are two modules.
 *
 * The collector lives at ~/Documents/dev-instances/jaeger — Jaeger UI on 8200,
 * OTLP on 4318. Point elsewhere with VITE_OTLP_ENDPOINT.
 *
 * Everything a caller can do lives on `tracer` below; `__hermesTrace` and the
 * HUD are two front ends onto it rather than two implementations of it.
 */

import { readKey, writeKey } from '@/lib/storage'

import { toOtlp, toOtlpBatch } from './otlp'
import { getRun, setRun } from './run'
import {
  beginSpan,
  type CaptureRoot,
  captureRoot,
  clearSpans,
  endSpan,
  isRecording,
  NO_SPAN,
  openSpanCount,
  rollCaptureIfStale,
  setRecording,
  spanCount,
  spans,
  takeCaptureRoot,
  takeCompleted
} from './span'

export const JAEGER_UI = 'http://localhost:8200'
const OTLP_ENDPOINT = (import.meta.env.VITE_OTLP_ENDPOINT as string | undefined) ?? 'http://127.0.0.1:4318/v1/traces'
const EXPORT_INTERVAL_MS = 2_000
const RECORDING_KEY = 'hermes.observability.recording'

let exporting = false
let lastFlushAt = 0
/**
 * Auto-drain to the collector. On by default when recording — Jaeger is the
 * store. Turn it off when you want `timeline()` instead: draining removes the
 * finished spans, so with it on the console view is only ever the last two
 * seconds. The two readouts want opposite things from the same buffer, and this
 * is the switch between them.
 */
let autoFlush = true

/** Serial of the currently open `mark`, so the next one can close it. */
let openMark = NO_SPAN

type Listener = () => void

const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/**
 * POST one batch. Failures are swallowed deliberately: the collector is usually
 * not running, and an app that logs a network error every two seconds because a
 * dev sink is down is worse than one that quietly keeps the spans.
 */
async function post(payload: unknown): Promise<void> {
  if (typeof fetch === 'undefined') {
    return
  }

  try {
    await fetch(OTLP_ENDPOINT, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
  } catch {
    // See above — a missing collector must stay silent.
  }
}

/**
 * Drain finished spans to the collector.
 *
 * Unlike the first version this does NOT wait for an idle stack and does NOT
 * clear the buffer. `takeCompleted` removes only the spans that have ended and
 * leaves the open ones in place, and parents are referenced by serial rather
 * than by slot, so a trace survives any number of drains. That is what a
 * capture longer than two seconds requires — the old idle-and-clear pair made a
 * long trace impossible rather than merely rare.
 *
 * `root` is sent exactly once, when the capture closes, because a span id may
 * only appear in a trace once.
 */
async function drain(root: CaptureRoot | null = null): Promise<void> {
  if (exporting) {
    return
  }

  // A roll closes one capture and opens the next, so its root has to go out in
  // the same breath as the spans that belong to it.
  const roots = [rollCaptureIfStale(), root].filter((r): r is CaptureRoot => r !== null)
  const batch = takeCompleted()

  if (batch.length === 0 && roots.length === 0) {
    return
  }

  exporting = true
  lastFlushAt = Date.now()

  try {
    await post(toOtlpBatch(batch, roots))
  } finally {
    exporting = false
    notify()
  }
}

const round = (value: number) => Math.round(value * 100) / 100

/** Indented waterfall, with each span's uncovered residue called out. */
function timeline() {
  const all = spans()

  if (all.length === 0) {
    return 'no spans — record, reproduce the interaction, then timeline(). If auto-drain is on they may already be in Jaeger; turn auto-drain off to keep them here.'
  }

  const t0 = all[0].startMs

  console.log(
    all
      .map(s =>
        [
          `${'  '.repeat(s.depth)}${s.name}`.padEnd(46),
          `@${round(s.startMs - t0)}ms`.padStart(12),
          `dur ${round(s.durationMs)}ms`.padStart(14),
          // The point of the whole exercise: time inside this span that nothing
          // instrumented accounts for.
          s.gapMs > 1 ? `UNACCOUNTED ${round(s.gapMs)}ms` : '',
          s.attrs ? JSON.stringify(s.attrs) : ''
        ].join(' ')
      )
      .join('\n')
  )

  return { run: getRun(), spans: all.length }
}

export interface TracerStatus {
  autoFlush: boolean
  capture: number
  openSpans: number
  recording: boolean
  run: string
  sinceFlushMs: number
  spans: number
}

/**
 * The one implementation of everything a caller can do.
 *
 * `__hermesTrace` and the floating HUD are both thin wrappers over this. They
 * used to be one wrapper and no implementation, which was fine while the
 * console was the only front end; adding a second would otherwise have meant
 * two copies of the flush-and-label logic drifting apart.
 */
export const tracer = {
  autoflush(on = true): void {
    autoFlush = on
    notify()
  },

  clear(): void {
    clearSpans()
    notify()
  },

  /** Send now. Closing a capture also sends its root, which completes the trace. */
  async flush(): Promise<void> {
    const closed = isRecording() ? null : takeCaptureRoot()

    await drain(closed)
  },

  /**
   * Open a named region inside the capture, closing the previous one.
   *
   * One trace per capture is what makes the waterfall causally complete; marks
   * are what make it navigable. Without them a ten-minute capture is a flat
   * list of four thousand spans with no answer to "which of these was the drag".
   */
  mark(label: string): void {
    if (openMark !== NO_SPAN) {
      endSpan(openMark)
      openMark = NO_SPAN
    }

    if (label) {
      openMark = beginSpan(`mark ${label}`, { mark: label })
    }

    notify()
  },

  otlp: toOtlp,

  /** Stop recording, then ship the tail plus the capture root. */
  async off(): Promise<void> {
    tracer.mark('')
    setRecording(false)
    writeKey(RECORDING_KEY, null)
    notify()

    await drain(takeCaptureRoot())
  },

  on(): void {
    setRecording(true, getRun())
    writeKey(RECORDING_KEY, 'true')
    notify()
  },

  run(label: string): void {
    setRun(label)
    notify()
  },

  status(): TracerStatus {
    return {
      autoFlush,
      capture: captureRoot().trace,
      openSpans: openSpanCount(),
      recording: isRecording(),
      run: getRun(),
      sinceFlushMs: lastFlushAt === 0 ? 0 : Date.now() - lastFlushAt,
      spans: spanCount()
    }
  },

  /** Subscribe to control-state changes. Returns an unsubscribe. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)

    return () => listeners.delete(listener)
  },

  timeline
}

/**
 * Install the console surface and the auto-drain timer. Called from
 * `install.ts` behind the dev/bench gate; a release build never reaches it, so
 * neither the endpoint nor the interval exists there.
 */
export function installTraceConsole(): void {
  if (typeof window === 'undefined') {
    return
  }

  // Recording is persisted, unlike the in-memory default. Editing any traced
  // module triggers a full reload (no HMR accept handler), and losing the flag
  // silently on every save makes the tool untrustworthy — you get a clean empty
  // capture with nothing to say why.
  if (readKey(RECORDING_KEY) === 'true') {
    tracer.on()
  }

  window.setInterval(() => {
    if (autoFlush) {
      void drain()
    }
  }, EXPORT_INTERVAL_MS)

  // A capture that is never stopped would otherwise lose both its tail and its
  // root — and a reload is by far the most common way a capture ends, because
  // editing any traced module triggers one.
  window.addEventListener('pagehide', () => {
    if (isRecording()) {
      setRecording(false)
      void drain(takeCaptureRoot())
    }
  })

  // MERGE, don't replace. The HUD hangs `hud()` — the only way back from its × —
  // off this same object, and whichever of the two installs second must not wipe
  // the other's keys. install.ts runs the console first today, but a control the
  // user cannot get back to should not depend on that staying true.
  const existing = (window as unknown as { __hermesTrace?: Record<string, unknown> }).__hermesTrace ?? {}

  Object.defineProperty(window, '__hermesTrace', {
    configurable: true,
    value: {
      ...existing,
      autoflush: (on = true) => {
        tracer.autoflush(on)

        return `auto-drain ${on ? 'on — spans go to Jaeger' : 'OFF — spans stay local for timeline()'}`
      },
      clear: () => tracer.clear(),
      flush: async () => {
        await tracer.flush()

        return `sent to ${OTLP_ENDPOINT} — ${JAEGER_UI}, service hermes-universal, run "${getRun()}"`
      },
      mark: (label: string) => {
        tracer.mark(label)

        return `mark "${label}" open — the next mark(), or off(), closes it`
      },
      off: async () => {
        await tracer.off()

        return `recording off — capture ${captureRoot().trace} complete in Jaeger`
      },
      on: () => {
        tracer.on()

        return `recording ON, run "${getRun()}" — one trace for this capture, drains to ${OTLP_ENDPOINT} every ${EXPORT_INTERVAL_MS}ms`
      },
      otlp: toOtlp,
      run: (label: string) => {
        tracer.run(label)

        return `run label "${label}" — search hermes.run="${label}" in Jaeger`
      },
      status: () => tracer.status(),
      timeline
    },
    writable: true
  })

  console.log(
    `observability: __hermesTrace.on() to record · run "${getRun()}" · recording=${isRecording()} · Jaeger ${JAEGER_UI}`
  )
}
