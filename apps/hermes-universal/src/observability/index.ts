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
 * The second rule, learned the same way: **a span with no parent on the stack
 * is not a new trace.** Every seam here is entered from a scheduled callback,
 * so treating an empty stack as "this is a root" turned one session into 573
 * single-span traces. Everything recorded between start and stop belongs to one
 * capture — see span.ts.
 *
 * What each piece is for:
 *
 *   span.ts        recording + gap analysis. Ships. Off by default.
 *   run.ts         the label that makes a capture findable in Jaeger.
 *   otlp.ts        OTLP/JSON serialisation. Ships (a bug report needs it).
 *   exporter.ts    POST to a collector, and the `tracer` control surface.
 *                                                        dev/bench only
 *   auto/events.ts every interaction, via PerformanceObserver.
 *   auto/stores.ts every nanostores write.               dev/bench only
 *   auto/http.ts   every HTTP request through the Rust transport.
 *   auto/websocket.ts  every websocket frame, both directions.
 *   auto/tauri-core.ts trace context over the IPC boundary. dev/bench only
 *
 * Import from here, not from the individual modules — the surface is
 * deliberately small so that call sites stay readable.
 */

export { toOtlp, toOtlpBatch, traceparentFor } from './otlp'
export { getRun, setRun } from './run'

export type { CaptureRoot, ExportSpan, SpanAttrs, TraceSpan } from './span'
export {
  beginDetached,
  beginSpan,
  captureRoot,
  clearSpans,
  endSpan,
  isRecording,
  NO_SPAN,
  openSpan,
  openSpanCount,
  peekAll,
  recordSpan,
  setRecording,
  span,
  spanAsync,
  spanCount,
  spans,
  takeCompleted
} from './span'
