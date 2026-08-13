/**
 * MoA fan-out progress. The property that matters: `moa.progress` arrives long
 * BEFORE any `moa.reference` (the loop only emits reference bodies once the
 * whole fan-out returns), so these frames are the only thing standing between
 * the user and a bare spinner for the length of the slowest reference.
 */

import { describe, expect, it } from 'vitest'

import type { GatewayEvent } from '@/gateway'
import { reduceSessionState } from '@/store/session-reducer'
import { emptySessionState } from '@/store/session-state-types'

const fold = (events: Array<[string, Record<string, unknown>]>) =>
  events.reduce(
    (state, [type, payload]) => reduceSessionState(state, { type } as GatewayEvent, payload),
    emptySessionState('stored-1')
  )

/** Reasoning text of the last assistant message, blocks joined by a separator. */
const reasoningBlocks = (state: ReturnType<typeof fold>) =>
  (state.messages.at(-1)?.parts ?? []).filter(part => part.type === 'reasoning').map(part => part.text)

describe('moa.progress', () => {
  it('renders a refs k/n trail, opening its own block on the first reference', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 3, label: 'model-a' }],
      ['moa.progress', { refs_done: 2, refs_total: 3, label: 'model-b' }],
      ['moa.progress', { refs_done: 3, refs_total: 3, label: 'model-c' }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ MoA refs 1/3 — model-a\n◇ MoA refs 2/3 — model-b\n◇ MoA refs 3/3 — model-c\n'
    ])
  })

  it('does not coalesce the trail into reasoning the model was already streaming', () => {
    const state = fold([
      ['message.start', {}],
      ['reasoning.delta', { text: 'weighing the options' }],
      ['moa.progress', { refs_done: 1, refs_total: 2, label: 'model-a' }]
    ])

    expect(reasoningBlocks(state)).toEqual(['weighing the options', '◇ MoA refs 1/2 — model-a\n'])
  })

  it('omits the dash when the gateway sends no label', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 2 }]
    ])

    expect(reasoningBlocks(state)).toEqual(['◇ MoA refs 1/2\n'])
  })

  it('ignores a frame missing its counters rather than rendering "undefined"', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { label: 'model-a' }],
      ['moa.progress', { refs_done: 1 }]
    ])

    expect(reasoningBlocks(state)).toEqual([])
  })
})

describe('moa.phase', () => {
  // `moa_loop.py` gates this frame on `if _ref_count:` and emits it after the
  // reference bodies, so the marker closes the fan-out record rather than
  // extending the live trail — see the ordered sequences at the bottom of this
  // file. With no reference in between it still lands on the trail.
  it('marks the aggregator taking over', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 1, label: 'model-a' }],
      ['moa.reference', { index: 1, count: 1, label: 'model-a', text: 'answer a' }],
      ['moa.phase', { phase: 'aggregator', aggregator: 'agg-model', refs_done: 1, refs_total: 1 }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ MoA refs 1/1 — model-a\n',
      '◇ Reference 1/1 — model-a\nanswer a',
      '◇ MoA aggregating…\n'
    ])
  })

  it('ignores phase:"reference", which only mirrors moa.progress and would double every line', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 1, label: 'model-a' }],
      ['moa.phase', { phase: 'reference', refs_done: 1, refs_total: 1 }]
    ])

    expect(reasoningBlocks(state)).toEqual(['◇ MoA refs 1/1 — model-a\n'])
  })

  it('ignores an unknown phase', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.phase', { phase: 'something-new' }]
    ])

    expect(reasoningBlocks(state)).toEqual([])
  })
})

/**
 * THE ORDER THE BACKEND ACTUALLY EMITS IN.
 *
 * `agent/moa_loop.py` runs `_run_references_parallel` (one `moa.progress` per
 * advisor as it completes), then loops the finished bodies out as
 * `moa.reference`, and only THEN emits `moa.phase` + `moa.aggregating`. So the
 * aggregating marker lands AFTER the advisory blocks, and the aggregator's own
 * reasoning lands after that, on the same session, with nothing in between.
 *
 * Every sequence below is in that order. An earlier version of this file put
 * `moa.phase` before the references, which the gateway never does — and that
 * ordering is exactly the one that hid the merge/overwrite bugs these tests pin.
 */
describe('the trail, the reference bodies and the aggregator together', () => {
  it('keeps the fan-out record, each reference, and the marker as separate blocks', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 2, label: 'model-a' }],
      ['moa.progress', { refs_done: 2, refs_total: 2, label: 'model-b' }],
      ['moa.reference', { index: 1, count: 2, label: 'model-a', text: 'answer a' }],
      ['moa.reference', { index: 2, count: 2, label: 'model-b', text: 'answer b' }],
      ['moa.phase', { phase: 'aggregator', refs_done: 2, refs_total: 2 }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ MoA refs 1/2 — model-a\n◇ MoA refs 2/2 — model-b\n',
      '◇ Reference 1/2 — model-a\nanswer a',
      '◇ Reference 2/2 — model-b\nanswer b',
      '◇ MoA aggregating…\n'
    ])
  })

  // The aggregator is a normal model call: it streams its own reasoning
  // immediately after the fan-out. It used to be concatenated onto the last
  // advisor's block — no separator, and attributed to that advisor's label.
  it('does not glue the aggregator’s streamed reasoning onto the last advisor', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.reference', { index: 1, count: 2, label: 'model-a', text: 'answer a' }],
      ['moa.reference', { index: 2, count: 2, label: 'model-b', text: 'answer b' }],
      ['moa.phase', { phase: 'aggregator', refs_done: 2, refs_total: 2 }],
      ['reasoning.delta', { text: 'weighing both answers' }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ Reference 1/2 — model-a\nanswer a',
      '◇ Reference 2/2 — model-b\nanswer b',
      '◇ MoA aggregating…\n',
      'weighing both answers'
    ])
  })

  // The worst of the three: a settled burst REPLACED the block it followed, so
  // the last advisor's answer was deleted from the transcript outright.
  it('does not overwrite an advisor block with the aggregator’s settled reasoning', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.reference', { index: 1, count: 2, label: 'model-a', text: 'answer a' }],
      ['moa.reference', { index: 2, count: 2, label: 'model-b', text: 'answer b' }],
      ['reasoning.available', { text: 'aggregator scratchpad' }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ Reference 1/2 — model-a\nanswer a',
      '◇ Reference 2/2 — model-b\nanswer b',
      'aggregator scratchpad'
    ])
  })

  // The settled-reasoning dedupe asks "did we already stream this thought?".
  // Another model's answer that happens to contain the same words is not that
  // thought, so a closed advisory block must not suppress it.
  it('does not let an advisor body swallow identical aggregator reasoning', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.reference', { index: 1, count: 1, label: 'model-a', text: 'use the second approach' }],
      ['reasoning.available', { text: 'use the second approach' }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ Reference 1/1 — model-a\nuse the second approach',
      'use the second approach'
    ])
  })

  // The seal must not leak into the prose channel: an advisory block sitting
  // between two answer deltas still may not split the sentence in two bubbles.
  it('leaves assistant text coalescing alone across a sealed advisory', () => {
    const state = fold([
      ['message.start', {}],
      ['message.delta', { text: 'the answer ' }],
      ['moa.reference', { index: 1, count: 1, label: 'model-a', text: 'answer a' }],
      ['message.delta', { text: 'is 42' }]
    ])

    expect((state.messages.at(-1)?.parts ?? []).filter(part => part.type === 'text').map(part => part.text)).toEqual([
      'the answer is 42'
    ])
  })
})

// Regression: the counters are numbers on a key called `count`, and the header
// used to read `payload.total` through `coerceText` — which returns '' for a
// number — so every reference rendered as a bare "◇ Reference / — model".
describe('moa.reference header', () => {
  it('numbers each reference from the count the gateway actually sends', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.reference', { index: 2, count: 3, label: 'model-b', text: 'answer b' }]
    ])

    expect(reasoningBlocks(state)).toEqual(['◇ Reference 2/3 — model-b\nanswer b'])
  })

  it('drops the fraction rather than printing an empty one when counters are absent', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.reference', { label: 'model-a', text: 'answer a' }]
    ])

    expect(reasoningBlocks(state)).toEqual(['◇ Reference — model-a\nanswer a'])
  })
})
