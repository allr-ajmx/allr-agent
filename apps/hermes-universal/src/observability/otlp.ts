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
import { spans, traceOf } from './span'

/**
 * ONE TRACE PER INTERACTION, not one per process and not one per buffer index.
 *
 * Jaeger keys on traceId, so a single constant id would collapse every drag,
 * every stream and every theme change of a session into one unopenable trace.
 *
 * The first version keyed on the root span's index, which has the same problem
 * in slow motion: `clearSpans` recycles indices every drain, so index 0 in one
 * flush window and index 0 in the next produced the same id. `traceOf` is a
 * counter that survives the drain instead — see span.ts.
 */
function traceIdFor(spanId: number): string {
  return `${SESSION_NONCE}${traceOf(spanId).toString(16).padStart(24, '0')}`
}

/**
 * OTLP wants 16 hex chars, and 0 is not a valid span id — hence the +1.
 *
 * Span indices ARE recycled by `clearSpans`, so two spans in different flush
 * windows can share this value. That is fine: span ids only have to be unique
 * within a trace, and `traceIdFor` now guarantees those two land in different
 * traces. It was NOT fine while trace ids recycled too.
 */
function spanIdHex(id: number): string {
  return (id + 1).toString(16).padStart(16, '0')
}

function attrValue(value: number | string) {
  return typeof value === 'number' ? { doubleValue: value } : { stringValue: value }
}

export function toOtlp(): unknown {
  // OTLP wants absolute nanoseconds since the epoch, while performance.now() is
  // a fractional millisecond offset from timeOrigin. Convert through timeOrigin
  // rather than treating the offsets as absolute, or every span lands in 1970.
  const origin = typeof performance === 'undefined' ? Date.now() : performance.timeOrigin
  const nanos = (ms: number) => String(Math.round((origin + ms) * 1e6))

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
        scopeSpans: [
          {
            scope: { name: 'hermes.observability' },
            spans: spans().map(s => ({
              attributes: Object.entries(s.attrs ?? {}).map(([key, value]) => ({ key, value: attrValue(value) })),
              endTimeUnixNano: nanos(s.startMs + s.durationMs),
              kind: 1,
              name: s.name,
              parentSpanId: s.parent === -1 ? '' : spanIdHex(s.parent),
              spanId: spanIdHex(s.id),
              startTimeUnixNano: nanos(s.startMs),
              traceId: traceIdFor(s.id)
            }))
          }
        ]
      }
    ]
  }
}
