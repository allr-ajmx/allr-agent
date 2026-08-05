import { beforeEach, describe, expect, it } from 'vitest'

import { toOtlp, toOtlpBatch } from './otlp'
import {
  beginSpan,
  captureRoot,
  clearSpans,
  endSpan,
  openSpanCount,
  recordSpan,
  setRecording,
  span,
  spanAsync,
  takeCaptureRoot,
  takeCompleted
} from './span'

interface OtlpSpan {
  name: string
  parentSpanId: string
  spanId: string
  traceId: string
}

type Payload = { resourceSpans: [{ scopeSpans: [{ spans: OtlpSpan[] }] }] }

function unwrap(payload: unknown): OtlpSpan[] {
  return (payload as Payload).resourceSpans[0].scopeSpans[0].spans
}

/** Everything currently held, plus the capture root. Non-destructive. */
function exported(): OtlpSpan[] {
  return unwrap(toOtlp())
}

/** What a drain would ship: finished spans only, and it empties them. */
function drained(): OtlpSpan[] {
  return unwrap(toOtlpBatch(takeCompleted()))
}

const byName = (all: OtlpSpan[], name: string) => all.find(s => s.name === name)!

/**
 * Regression tests for trace IDENTITY.
 *
 * Two bugs live here, and they are opposites.
 *
 * The first: trace ids derived from the root span's buffer INDEX. The exporter
 * recycles indices on every drain, so root index 0 in one flush window and root
 * index 0 in the next produced the SAME id, silently merging unrelated work.
 *
 * The second, and much worse: a span whose synchronous stack was empty became a
 * ROOT, and every root minted a new trace. Every seam in this app is entered
 * from a scheduled callback — a PerformanceObserver, a Tauri listener, a React
 * render, an await continuation — so in practice EVERY span was a root. One
 * session produced 573 traces of one span each. Nothing nested, and `gapMs` had
 * nothing to subtract from.
 *
 * The fix for both is the same shape: identity comes from the capture, and
 * parentage falls back to the capture root rather than to nothing.
 */
describe('trace identity', () => {
  beforeEach(() => {
    setRecording(false)
    clearSpans()
    setRecording(true, 'test')
  })

  it('puts every span in one capture into one trace', () => {
    // The regression that motivated all of this: these two are unrelated and
    // both start with an empty stack. They are still one trace.
    span('a', () => {})
    span('b', () => {})

    const all = exported()

    expect(byName(all, 'a').traceId).toBe(byName(all, 'b').traceId)
  })

  it('hangs a stackless span off the capture root rather than off nothing', () => {
    span('scheduled', () => {})

    const all = exported()
    const root = all.find(s => s.parentSpanId === '')!

    expect(byName(all, 'scheduled').parentSpanId).toBe(root.spanId)
  })

  it('keeps the capture root as the only parentless span', () => {
    span('outer', () => span('inner', () => {}))
    recordSpan('late', 0, 1)

    expect(exported().filter(s => s.parentSpanId === '')).toHaveLength(1)
  })

  it('nests children under their parent', () => {
    span('parent', () => {
      span('child', () => {})
    })

    const all = exported()

    expect(byName(all, 'child').parentSpanId).toBe(byName(all, 'parent').spanId)
    expect(byName(all, 'child').traceId).toBe(byName(all, 'parent').traceId)
  })

  it('starts a new trace for a new capture', () => {
    span('first', () => {})
    const first = byName(exported(), 'first').traceId

    setRecording(false)
    setRecording(true, 'test')

    span('second', () => {})

    expect(byName(exported(), 'second').traceId).not.toBe(first)
  })

  it('does not reuse span ids across drains', () => {
    const seen = new Set<string>()

    for (let i = 0; i < 50; i += 1) {
      span(`n-${i}`, () => {})

      for (const s of drained()) {
        seen.add(s.spanId)
      }
    }

    expect(seen.size).toBe(50)
  })

  it('resolves a parent that drained several batches earlier', () => {
    // The ssh_connect shape, which is the case the index-based parent could not
    // survive: an operation open across many flush windows, with children
    // arriving long after the batch its parent was recorded in.
    const outer = beginSpan('long')
    let childParent = ''

    // The open span is not shipped, so this first drain is empty.
    expect(drained()).toHaveLength(0)

    for (let i = 0; i < 3; i += 1) {
      span(`tick-${i}`, () => {})
      childParent = byName(drained(), `tick-${i}`).parentSpanId
    }

    endSpan(outer)

    const closed = byName(drained(), 'long')

    expect(childParent).toBe(closed.spanId)
  })

  it('leaves open spans in the buffer when a batch drains', () => {
    const outer = beginSpan('still-open')

    span('done', () => {})

    expect(drained().map(s => s.name)).toEqual(['done'])
    expect(openSpanCount()).toBe(1)

    endSpan(outer)

    expect(drained().map(s => s.name)).toEqual(['still-open'])
  })

  it('does not leave an async span on the synchronous stack', () => {
    // The http.request bug: a stack-pushed span held across an await swept
    // every concurrently-opened span underneath it, and closing it truncated
    // the stack out from under spans that were legitimately open.
    let observed = -1

    const pending = spanAsync('request', async () => {
      observed = openSpanCount()
    })

    return pending.then(() => {
      expect(observed).toBe(0)

      const all = exported()
      const root = all.find(s => s.parentSpanId === '')!

      expect(byName(all, 'request').parentSpanId).toBe(root.spanId)
    })
  })

  it('hands out the capture root exactly once, and only once closed', () => {
    expect(takeCaptureRoot()).toBeNull()

    setRecording(false)

    expect(takeCaptureRoot()?.serial).toBe(captureRoot().serial)
    expect(takeCaptureRoot()).toBeNull()
  })

  it('emits a 32-hex trace id and a 16-hex span id', () => {
    span('shape', () => {})

    const only = byName(exported(), 'shape')

    expect(only.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(only.spanId).toMatch(/^[0-9a-f]{16}$/)
    // OTLP forbids an all-zero span id; serials starting at 1 is what avoids it.
    expect(only.spanId).not.toBe('0'.repeat(16))
  })
})
