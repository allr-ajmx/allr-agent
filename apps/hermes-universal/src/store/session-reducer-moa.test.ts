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
  it('marks the aggregator taking over, appended onto the progress trail', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 1, label: 'model-a' }],
      ['moa.phase', { phase: 'aggregator', aggregator: 'agg-model', refs_done: 1, refs_total: 1 }]
    ])

    expect(reasoningBlocks(state)).toEqual(['◇ MoA refs 1/1 — model-a\n◇ MoA aggregating…\n'])
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

describe('the trail and the reference bodies together', () => {
  it('keeps the fan-out record above each reference, which stays its own block', () => {
    const state = fold([
      ['message.start', {}],
      ['moa.progress', { refs_done: 1, refs_total: 2, label: 'model-a' }],
      ['moa.progress', { refs_done: 2, refs_total: 2, label: 'model-b' }],
      ['moa.phase', { phase: 'aggregator', refs_done: 2, refs_total: 2 }],
      ['moa.reference', { index: 1, count: 2, label: 'model-a', text: 'answer a' }],
      ['moa.reference', { index: 2, count: 2, label: 'model-b', text: 'answer b' }]
    ])

    expect(reasoningBlocks(state)).toEqual([
      '◇ MoA refs 1/2 — model-a\n◇ MoA refs 2/2 — model-b\n◇ MoA aggregating…\n',
      '◇ Reference 1/2 — model-a\nanswer a',
      '◇ Reference 2/2 — model-b\nanswer b'
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
