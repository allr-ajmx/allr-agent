import { beforeEach, describe, expect, it } from 'vitest'

import { toOtlp } from './otlp'
import { beginSpan, clearSpans, endSpan, setRecording, span, traceOf } from './span'

interface OtlpSpan {
  name: string
  parentSpanId: string
  spanId: string
  traceId: string
}

function exported(): OtlpSpan[] {
  const payload = toOtlp() as {
    resourceSpans: [{ scopeSpans: [{ spans: OtlpSpan[] }] }]
  }

  return payload.resourceSpans[0].scopeSpans[0].spans
}

/**
 * Regression tests for trace IDENTITY.
 *
 * Trace ids were originally derived from the root span's buffer INDEX. That
 * looks equivalent to deriving them from the trace, and is not: the exporter
 * calls `clearSpans()` every couple of seconds, which resets the index counter,
 * so root index 0 in one flush window and root index 0 in the next produced the
 * SAME trace id. Jaeger keys on trace id, so unrelated interactions silently
 * merged — and a long operation spanning many drains could have its backend
 * children attached to whatever trace later occupied the same index.
 */
describe('trace identity', () => {
  beforeEach(() => {
    setRecording(false)
    setRecording(true)
  })

  it('gives each root span its own trace', () => {
    span('a', () => {})
    span('b', () => {})

    const [a, b] = exported()

    expect(a.traceId).not.toBe(b.traceId)
  })

  it('puts children in their parent trace', () => {
    span('parent', () => {
      span('child', () => {})
    })

    const [parent, child] = exported()

    expect(child.traceId).toBe(parent.traceId)
    expect(child.parentSpanId).toBe(parent.spanId)
  })

  it('does NOT reuse trace ids after a drain', () => {
    // The bug, reproduced exactly: one root, drain, another root.
    span('first', () => {})
    const first = exported()[0].traceId

    clearSpans()

    span('second', () => {})
    const second = exported()[0].traceId

    expect(second).not.toBe(first)
  })

  it('keeps trace ids distinct across many drains', () => {
    const seen = new Set<string>()

    for (let i = 0; i < 50; i += 1) {
      span(`root-${i}`, () => {})
      seen.add(exported()[0].traceId)
      clearSpans()
    }

    expect(seen.size).toBe(50)
  })

  it('keeps a long-lived span in its own trace while drains happen around it', () => {
    // The ssh_connect shape: a span open across many flush windows. Its trace
    // must not collide with traces started later.
    const outer = beginSpan('long')
    const outerTrace = traceOf(outer)

    endSpan(outer)
    clearSpans()

    span('later', () => {})

    expect(traceOf(0)).not.toBe(outerTrace)
  })

  it('emits a 32-hex trace id and a 16-hex span id', () => {
    span('shape', () => {})

    const [only] = exported()

    expect(only.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(only.spanId).toMatch(/^[0-9a-f]{16}$/)
    // OTLP forbids an all-zero span id; the +1 offset is what avoids it.
    expect(only.spanId).not.toBe('0'.repeat(16))
  })

  it('marks a root span with an empty parent', () => {
    span('root', () => {})

    expect(exported()[0].parentSpanId).toBe('')
  })
})
