/**
 * Ship spans to a local OpenTelemetry collector, and expose the console surface.
 *
 * DEV/BENCH ONLY. `toOtlp()` next door ships in release because a bug report
 * needs serialisation; this file does not, because a release build must never
 * hold a hardcoded collector URL or make an unsolicited outbound request. The
 * split is the whole reason they are two modules.
 *
 * The collector lives at ~/Documents/dev-instances/jaeger — Jaeger UI on 8200,
 * OTLP on 4318. Point elsewhere with VITE_OTLP_ENDPOINT.
 *
 *   __hermesTrace.on()                 start recording (persisted)
 *   __hermesTrace.run('before-fix')    label this capture
 *   __hermesTrace.timeline()           console waterfall, gaps marked
 *   __hermesTrace.flush()              send now
 *   __hermesTrace.autoflush(false)     keep spans local for timeline()
 */

import { readKey, writeKey } from '@/lib/storage'

import { toOtlp } from './otlp'
import { getRun, setRun } from './run'
import { clearSpans, isIdle, isRecording, setRecording, spanCount, spans } from './span'

const OTLP_ENDPOINT = (import.meta.env.VITE_OTLP_ENDPOINT as string | undefined) ?? 'http://127.0.0.1:4318/v1/traces'
const EXPORT_INTERVAL_MS = 2_000
const RECORDING_KEY = 'hermes.observability.recording'

let exporting = false
/**
 * Auto-drain to the collector. On by default when recording — Jaeger is the
 * store. Turn it off when you want `timeline()` instead: draining clears the
 * buffer, so with it on the console view is only ever the last two seconds. The
 * two readouts want opposite things from the same buffer, and this is the
 * switch between them.
 */
let autoFlush = true

/**
 * Drain completed spans to the collector.
 *
 * ONLY while no span is open. Clearing the buffer mid-gesture would leave every
 * span recorded afterwards pointing at a parent index that no longer exists — a
 * waterfall with its roots cut off. An idle stack also happens to be exactly
 * when a trace is complete enough to be worth sending.
 *
 * Failures are swallowed deliberately: the collector is usually not running,
 * and an app that logs a network error every two seconds because a dev sink is
 * down is worse than one that quietly keeps the spans for `timeline()`.
 */
export async function flushToCollector(): Promise<void> {
  if (!isRecording() || exporting || spanCount() === 0 || !isIdle() || typeof fetch === 'undefined') {
    return
  }

  const payload = toOtlp()

  exporting = true

  // Cleared BEFORE the await, not after: spans keep arriving during the POST,
  // and clearing on the far side would discard everything recorded while it was
  // in flight.
  clearSpans()

  try {
    await fetch(OTLP_ENDPOINT, {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
  } catch {
    // See above — a missing collector must stay silent.
  } finally {
    exporting = false
  }
}

const round = (value: number) => Math.round(value * 100) / 100

/** Indented waterfall, with each span's uncovered residue called out. */
function timeline() {
  const all = spans()

  if (all.length === 0) {
    return 'no spans — __hermesTrace.on(), reproduce the interaction, then timeline(). If auto-drain is on they may already be in Jaeger; __hermesTrace.autoflush(false) keeps them here.'
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

/**
 * Install the console surface. Called from main.tsx behind the dev/bench gate;
 * a release build never reaches it, so neither the endpoint nor the interval
 * exists there.
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
    setRecording(true)
  }

  window.setInterval(() => {
    if (autoFlush) {
      void flushToCollector()
    }
  }, EXPORT_INTERVAL_MS)

  Object.defineProperty(window, '__hermesTrace', {
    configurable: true,
    value: {
      autoflush: (on = true) => {
        autoFlush = on

        return `auto-drain ${on ? 'on — spans go to Jaeger' : 'OFF — spans stay local for timeline()'}`
      },
      clear: clearSpans,
      flush: async () => {
        await flushToCollector()

        return `sent to ${OTLP_ENDPOINT} — http://localhost:8200, service hermes-universal, run "${getRun()}"`
      },
      off: () => {
        setRecording(false)
        writeKey(RECORDING_KEY, null)

        return 'recording off'
      },
      on: () => {
        setRecording(true)
        writeKey(RECORDING_KEY, 'true')

        return `recording ON, run "${getRun()}" — drains to ${OTLP_ENDPOINT} every ${EXPORT_INTERVAL_MS}ms`
      },
      otlp: toOtlp,
      run: (label: string) => {
        setRun(label)

        return `run label "${label}" — search hermes.run="${label}" in Jaeger`
      },
      timeline
    },
    writable: true
  })

  console.log(
    `observability: __hermesTrace.on() to record · run "${getRun()}" · recording=${isRecording()} · Jaeger http://localhost:8200`
  )
}
