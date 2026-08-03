/**
 * PER-SESSION streaming delta batching.
 *
 * Universal committed React state per token. At typical LLM rates (~30-80
 * tok/sec) that is one commit + one markdown re-parse per token, and the
 * re-parse cost grows with the length of the block being appended to. Running
 * several sessions at once multiplies it.
 *
 * Deltas accumulate per session key and flush on a timer. Ported from desktop
 * `app/session/hooks/use-message-stream/index.ts`; rewritten as plain module
 * state because universal's reducer is not in React (desktop's version is a set
 * of `useCallback`s over `useRef`s inside a hook).
 */

// 33ms lets ~2 tokens batch into one commit at 60 tok/sec without visible lag
// on the streaming text (still 30fps of text growth). The previous behaviour —
// one commit per token — made long messages with big trailing paragraphs
// noticeably choppy.
export const STREAM_DELTA_FLUSH_MS = 33

// Ceiling for the ADAPTIVE flush gap (see `scheduleFlush`). Under heavy
// multi-stream load the gap stretches to 3x the measured flush cost so the main
// thread stays responsive to input; this cap guarantees streaming text still
// visibly updates at least ~4x per second no matter the load.
export const MAX_STREAM_FLUSH_GAP_MS = 250

export type DeltaChannel = 'assistant' | 'reasoning'

interface QueuedStreamDeltas {
  assistant: string
  reasoning: string
}

/** How a flushed batch is applied to one session. Set once, by the router. */
export type StreamBatchSink = (key: string, channel: DeltaChannel, text: string) => void

let sink: StreamBatchSink | null = null
const queued = new Map<string, QueuedStreamDeltas>()

let flushHandle: null | ReturnType<typeof setTimeout> = null
let lastFlushAt = 0
// What the previous flush cost on the main thread — drives the adaptive floor.
let lastFlushCost = 0

export function setStreamBatchSink(next: StreamBatchSink): void {
  sink = next
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/**
 * Apply queued deltas — for ONE session, or for all of them.
 *
 * Callers must flush a session before applying any NON-delta event to it:
 * deltas are deferred while `tool.start` / `message.complete` apply
 * immediately, so an unflushed delta would land after the tool row that came
 * after it.
 */
export function flushDeltas(key?: string): void {
  const keys = key === undefined ? [...queued.keys()] : queued.has(key) ? [key] : []

  for (const id of keys) {
    const batch = queued.get(id)
    queued.delete(id)

    if (!batch || !sink) {
      continue
    }

    if (batch.assistant) {
      sink(id, 'assistant', batch.assistant)
    }

    if (batch.reasoning) {
      sink(id, 'reasoning', batch.reasoning)
    }
  }
}

function scheduleFlush(): void {
  if (flushHandle !== null) {
    return
  }

  if (typeof setTimeout === 'undefined') {
    flushDeltas()

    return
  }

  // Enforce a floor on the gap between two flushes, scaled by what the last
  // flush actually cost. With several sessions streaming at once, one flush
  // carries every stream's commit + markdown re-parse; when that work
  // approaches the fixed 33ms budget, back-to-back flushes leave the main
  // thread no idle frames and every interaction (typing, resize, hover)
  // stutters even though no render is wasted. Yielding 3x the measured cost
  // keeps the thread ~75% idle for input at any load: cheap flushes stay at
  // 30fps of text growth, expensive multi-stream flushes degrade text fps
  // instead of interactivity — capped so text never updates slower than 4/s.
  const sinceLast = now() - lastFlushAt
  const adaptiveFloor = Math.min(Math.max(STREAM_DELTA_FLUSH_MS, lastFlushCost * 3), MAX_STREAM_FLUSH_GAP_MS)

  // Always a timer, never requestAnimationFrame. Chromium (and WebKitGTK, and
  // an Android WebView) pauses rAF for a view it considers hidden, and "hidden"
  // is not something this code can verify — a minimized window, an off-screen
  // one, or a backgrounded app all qualify. In those states an rAF-gated flush
  // never runs, so a finished answer sits in this queue until some later input
  // wakes a frame: the reply looks stalled, then arrives all at once. A timer
  // keeps the same coalescing cadence while guaranteeing delivery without user
  // interaction.
  flushHandle = setTimeout(
    () => {
      flushHandle = null
      const startedAt = now()
      lastFlushAt = startedAt
      flushDeltas()
      lastFlushCost = now() - startedAt
    },
    Math.max(0, adaptiveFloor - sinceLast)
  )
}

/** Queue one streaming delta for a session. */
export function queueDelta(key: string, channel: DeltaChannel, delta: string): void {
  if (!delta) {
    return
  }

  const batch = queued.get(key) ?? { assistant: '', reasoning: '' }
  batch[channel] += delta
  queued.set(key, batch)
  scheduleFlush()
}

/** Drop a session's pending deltas without applying them (the slice is gone). */
export function discardDeltas(key: string): void {
  queued.delete(key)
}

/** Cancel the pending timer and clear every queue — for teardown and tests. */
export function disposeStreamBatch(): void {
  if (flushHandle !== null) {
    clearTimeout(flushHandle)
    flushHandle = null
  }

  queued.clear()
  lastFlushAt = 0
  lastFlushCost = 0
}
