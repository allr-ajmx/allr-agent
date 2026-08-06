/**
 * WebSocket autocapture.
 *
 * `transport/tauri-websocket.ts` is the physical seam for all gateway traffic —
 * one place per direction — so spanning it covers every JSON-RPC frame without
 * touching the protocol layer above.
 *
 * WHAT IS SPANNED, AND WHAT DELIBERATELY IS NOT
 *
 * An inbound frame's span covers DISPATCH, not arrival: the listeners run
 * synchronously off it, and on the streaming path those listeners are the whole
 * chat pipeline. So a `ws.message` span whose gap is large means the app spent
 * that time reacting to a frame — which is exactly the question worth asking of
 * a slow stream, and the reason to instrument the seam at all rather than just
 * counting bytes.
 *
 * Frame CONTENT is never recorded. These frames carry conversation text,
 * prompts and tool output; a span attribute can end up in a shared trace. Only
 * the RPC method name — parsed defensively, dropped on any doubt — and the frame
 * size go in.
 *
 * Ships. Nothing is recorded while tracing is off.
 */

import { beginSpan, endSpan, isRecording, type SpanAttrs } from '../span'

/**
 * The JSON-RPC method or event type of a frame, for labelling only.
 *
 * Returns undefined rather than guessing. A mislabelled span is worse than an
 * unlabelled one, and the parse runs on every inbound frame — so it bails on
 * anything unexpected instead of reaching further into the payload.
 */
export function frameLabel(payload: unknown): string | undefined {
  if (typeof payload !== 'string' || payload.length === 0 || payload[0] !== '{') {
    return undefined
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const method = parsed.method ?? (parsed.params as Record<string, unknown> | undefined)?.type

    return typeof method === 'string' ? method : undefined
  } catch {
    return undefined
  }
}

function frameAttrs(payload: unknown): SpanAttrs {
  const attrs: SpanAttrs = {}
  const method = frameLabel(payload)

  if (method) {
    attrs.method = method
  }

  if (typeof payload === 'string') {
    attrs.bytes = payload.length
  }

  return attrs
}

/**
 * Span the synchronous dispatch of an inbound frame.
 *
 * `isRecording()` is checked before `frameAttrs` so the JSON parse — which runs
 * per frame, at stream rate — never happens while tracing is off.
 */
export function spanInboundFrame(payload: unknown, dispatch: () => void): void {
  if (!isRecording()) {
    dispatch()

    return
  }

  const id = beginSpan('ws.message', frameAttrs(payload))

  try {
    dispatch()
  } finally {
    endSpan(id)
  }
}

/** Span an outbound frame. Cheap by comparison — it is a queue push or an IPC call. */
export function spanOutboundFrame(text: string, send: () => void): void {
  if (!isRecording()) {
    send()

    return
  }

  const id = beginSpan('ws.send', frameAttrs(text))

  try {
    send()
  } finally {
    endSpan(id)
  }
}
