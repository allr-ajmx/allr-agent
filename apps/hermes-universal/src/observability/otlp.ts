/**
 * OTLP/JSON serialisation — the format an OpenTelemetry collector accepts on
 * `/v1/traces`, and the format Jaeger's UI accepts from its "Upload JSON" tab.
 *
 * This is a pure function and it SHIPS, unlike the network exporter beside it.
 * That split is deliberate: a user reproducing a bug can be asked to record and
 * copy a trace, which needs serialisation but must never need a reachable
 * collector or an outbound request.
 */

import { getRun, SERVICE_NAME, SESSION_NONCE } from './run'
import { type CaptureRoot, captureRoot, type ExportSpan, peekAll } from './span'

/**
 * ONE TRACE PER CAPTURE.
 *
 * Jaeger keys on traceId. Two failure modes sit either side of this function
 * and both have been hit:
 *
 *   A single constant id merges every drag, stream and theme change of a
 *   session into one trace nobody can open.
 *
 *   An id per ROOT span shatters the session instead — and because every seam
 *   in this app is entered from a scheduled callback, "root" meant "every
 *   span". One session produced 573 traces, essentially all of them one span.
 *
 * The capture counter is the middle: it advances when a human starts recording,
 * not when the event loop happens to turn over. The session nonce keeps two
 * windows, or two reloads, from colliding.
 */
function traceIdFor(trace: number): string {
  return `${SESSION_NONCE}${trace.toString(16).padStart(24, '0')}`
}

/**
 * OTLP wants 16 hex chars, and an all-zero span id means "none" — which is
 * exactly what a serial of 0 (`NO_SPAN`, and the parent of a root) means here,
 * so the two line up without a special case.
 *
 * Serials are monotonic for the life of the page and no drain resets them, so
 * unlike the buffer indices this replaced, two different spans can never share
 * one id.
 */
function spanIdHex(serial: number): string {
  return serial.toString(16).padStart(16, '0')
}

function attrValue(value: number | string) {
  return typeof value === 'number' ? { doubleValue: value } : { stringValue: value }
}

/**
 * The W3C `traceparent` header value for a span.
 *
 * This is how the Rust half joins the frontend's trace: the invoke wrapper puts
 * it on the IPC request and the backend reads it back as a remote parent. The
 * `01` tail is the sampled flag — we only ever emit context for spans we are in
 * fact recording, so it is never anything else.
 */
export function traceparentFor(trace: number, serial: number): string {
  return `00-${traceIdFor(trace)}-${spanIdHex(serial)}-01`
}

// OTLP wants absolute nanoseconds since the epoch, while performance.now() is a
// fractional millisecond offset from timeOrigin. Convert through timeOrigin
// rather than treating the offsets as absolute, or every span lands in 1970.
const timeOrigin = (): number => (typeof performance === 'undefined' ? Date.now() : performance.timeOrigin)

function encode(batch: ExportSpan[], roots: CaptureRoot[]) {
  const origin = timeOrigin()
  const nanos = (ms: number) => String(Math.round((origin + ms) * 1e6))

  const encodeOne = (s: ExportSpan) => ({
    attributes: Object.entries(s.attrs ?? {}).map(([key, value]) => ({ key, value: attrValue(value) })),
    endTimeUnixNano: nanos(Number.isNaN(s.endMs) ? s.startMs : s.endMs),
    kind: 1,
    name: s.name,
    parentSpanId: s.parent === 0 ? '' : spanIdHex(s.parent),
    spanId: spanIdHex(s.serial),
    startTimeUnixNano: nanos(s.startMs),
    traceId: traceIdFor(s.trace)
  })

  const encoded = batch.map(encodeOne)

  for (const root of roots) {
    encoded.push(
      encodeOne({
        attrs: root.attrs,
        endMs: root.endMs ?? root.startMs,
        name: root.name,
        parent: 0,
        serial: root.serial,
        startMs: root.startMs,
        trace: root.trace
      })
    )
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: SERVICE_NAME } },
            // The findable-in-Jaeger label. See run.ts.
            { key: 'hermes.run', value: { stringValue: getRun() } },
            { key: 'telemetry.sdk.language', value: { stringValue: 'webjs' } }
          ]
        },
        scopeSpans: [{ scope: { name: 'hermes.observability' }, spans: encoded }]
      }
    ]
  }
}

/**
 * Serialise one drained batch.
 *
 * The capture root is passed in rather than read here because it must be sent
 * EXACTLY ONCE — re-sending it on every drain would leave Jaeger holding a
 * dozen copies of one span id, all with different end times. The exporter owns
 * that decision; this only encodes what it is handed.
 */
export function toOtlpBatch(batch: ExportSpan[], roots: CaptureRoot[] = []): unknown {
  return encode(batch, roots)
}

/**
 * Serialise everything currently held, without disturbing the buffer.
 *
 * For the hand-copied dump (`__hermesTrace.otlp()`, the HUD's copy button),
 * which has to stand on its own in Jaeger's upload tab — so it always carries
 * the capture root, even mid-capture where the end time is provisional.
 */
export function toOtlp(): unknown {
  return encode(peekAll(), [captureRoot()])
}
