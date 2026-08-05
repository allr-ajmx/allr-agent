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
import { rootOf, spans } from './span'

/**
 * ONE TRACE PER ROOT SPAN, not one per process.
 *
 * Jaeger keys on traceId, so a single constant id would collapse every drag,
 * every stream and every theme change of a session into one trace that grows
 * without bound and eventually cannot be opened at all. Keying on the root span
 * makes one interaction one trace, which is the unit anyone actually wants to
 * look at.
 */
function traceIdFor(spanId: number): string {
  return `${SESSION_NONCE}${(rootOf(spanId) + 1).toString(16).padStart(24, '0')}`
}

/** OTLP wants 16 hex chars, and 0 is not a valid span id — hence the +1. */
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
