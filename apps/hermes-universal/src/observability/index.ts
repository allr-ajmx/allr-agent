/**
 * Observability — span tracing for hermes-universal.
 *
 * The design in one line: **auto-instrument the seams, hand-instrument only
 * what the machine cannot name.**
 *
 * That rule comes from a real cost. Chasing a slow pane drag, a hand-placed
 * span on `$layoutTree` recorded nothing at all — because a sidebar is a fixed
 * track and writes `$paneStates` instead. A manual span encodes a guess about
 * where the time goes, and a wrong guess is invisible: you get a clean empty
 * result and no hint that you measured the wrong thing. The autocaptures in
 * `auto/` exist so that being wrong about the location costs nothing.
 *
 * What each piece is for:
 *
 *   span.ts        recording + gap analysis. Ships. Off by default.
 *   run.ts         the label that makes a capture findable in Jaeger.
 *   otlp.ts        OTLP/JSON serialisation. Ships (a bug report needs it).
 *   exporter.ts    POST to a local collector.            dev/bench only
 *   auto/events.ts every interaction, via PerformanceObserver.
 *   auto/stores.ts every nanostores write.               dev/bench only
 *   auto/transport.ts  every HTTP request and websocket frame.
 *
 * Import from here, not from the individual modules — the surface is
 * deliberately small so that call sites stay readable.
 */

export { toOtlp } from './otlp'
export { getRun, setRun } from './run'

export type { SpanAttrs, TraceSpan } from './span'
export {
  beginSpan,
  clearSpans,
  endSpan,
  isRecording,
  NO_SPAN,
  recordSpan,
  setRecording,
  span,
  spanCount,
  spans
} from './span'
