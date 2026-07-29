import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  discardDeltas,
  disposeStreamBatch,
  flushDeltas,
  MAX_STREAM_FLUSH_GAP_MS,
  queueDelta,
  setStreamBatchSink,
  STREAM_DELTA_FLUSH_MS
} from './stream-batch'

type Applied = [key: string, channel: string, text: string]

let applied: Applied[]

beforeEach(() => {
  vi.useFakeTimers()
  applied = []
  setStreamBatchSink((key, channel, text) => applied.push([key, channel, text]))
})

afterEach(() => {
  disposeStreamBatch()
  vi.useRealTimers()
})

describe('stream batching', () => {
  it('coalesces consecutive deltas into one application', () => {
    queueDelta('s1', 'assistant', 'Hel')
    queueDelta('s1', 'assistant', 'lo ')
    queueDelta('s1', 'assistant', 'world')

    expect(applied).toEqual([]) // nothing applied yet — that is the point

    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS)

    expect(applied).toEqual([['s1', 'assistant', 'Hello world']])
  })

  // The whole reason this is keyed: several sessions stream at once, and one
  // flush must not merge their text.
  it('keeps concurrent sessions and channels apart', () => {
    queueDelta('s1', 'assistant', 'A1')
    queueDelta('s2', 'assistant', 'B1')
    queueDelta('s1', 'reasoning', 'think A')
    queueDelta('s2', 'assistant', 'B2')
    queueDelta('s1', 'assistant', 'A2')

    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS)

    expect(applied).toEqual([
      ['s1', 'assistant', 'A1A2'],
      ['s1', 'reasoning', 'think A'],
      ['s2', 'assistant', 'B1B2']
    ])
  })

  it('flushes one session without touching another', () => {
    queueDelta('s1', 'assistant', 'mine')
    queueDelta('s2', 'assistant', 'theirs')

    flushDeltas('s1')

    expect(applied).toEqual([['s1', 'assistant', 'mine']])
  })

  // Deltas are deferred while tool/complete events apply immediately, so the
  // router flushes before every non-delta event. Without that, a queued token
  // would land after the tool row that actually came after it.
  it('applies queued text before a later non-delta event can overtake it', () => {
    queueDelta('s1', 'assistant', 'before the tool')
    flushDeltas('s1') // what the router does on tool.start

    expect(applied).toEqual([['s1', 'assistant', 'before the tool']])

    queueDelta('s1', 'assistant', 'after the tool')
    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS)

    expect(applied).toEqual([
      ['s1', 'assistant', 'before the tool'],
      ['s1', 'assistant', 'after the tool']
    ])
  })

  it('drops a discarded session queue without applying it', () => {
    queueDelta('s1', 'assistant', 'gone')
    discardDeltas('s1')

    vi.advanceTimersByTime(MAX_STREAM_FLUSH_GAP_MS)

    expect(applied).toEqual([])
  })

  // The floor scales with what the last flush cost, so heavy multi-stream load
  // degrades text fps instead of interactivity — but never past the cap.
  it('backs off after an expensive flush, up to the cap', () => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)

    // A flush that "costs" 40ms of main-thread time.
    setStreamBatchSink(() => {
      clock += 40
    })

    queueDelta('s1', 'assistant', 'x')
    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS)

    setStreamBatchSink((key, channel, text) => applied.push([key, channel, text]))
    queueDelta('s1', 'assistant', 'y')

    // 3x the 40ms cost = 120ms, so 33ms is not enough to trigger the next flush.
    vi.advanceTimersByTime(STREAM_DELTA_FLUSH_MS)
    expect(applied).toEqual([])

    vi.advanceTimersByTime(MAX_STREAM_FLUSH_GAP_MS)
    expect(applied).toEqual([['s1', 'assistant', 'y']])
  })

  it('ignores empty deltas', () => {
    queueDelta('s1', 'assistant', '')
    vi.advanceTimersByTime(MAX_STREAM_FLUSH_GAP_MS)

    expect(applied).toEqual([])
  })
})
