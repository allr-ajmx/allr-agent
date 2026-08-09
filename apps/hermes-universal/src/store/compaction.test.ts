import { beforeEach, describe, expect, it } from 'vitest'

import {
  $activeSessionCompacting,
  $compactingSessions,
  clearAllCompaction,
  routeCompactionEvent,
  sessionCompacting,
  setSessionCompacting,
  turnCompacted
} from '@/store/compaction'
import { $activeSessionKey } from '@/store/session-state-types'
import { beginTurn, clearAllTurns, getInflightTurn, settleTurn } from '@/store/turn-lifecycle'

const status = (kind: string) => ({ kind })

beforeEach(() => {
  clearAllCompaction()
  clearAllTurns()
  $activeSessionKey.set('s1')
})

describe('setSessionCompacting', () => {
  it('is per session', () => {
    setSessionCompacting('s1', true)

    expect(sessionCompacting('s1').get()).toBe(true)
    expect(sessionCompacting('s2').get()).toBe(false)
    expect($activeSessionCompacting.get()).toBe(true)
  })

  it('mirrors onto the live turn record, so the two stores cannot disagree', () => {
    beginTurn('s1', { prompt: 'a' })
    setSessionCompacting('s1', true)

    expect(getInflightTurn('s1')?.compacting).toBe(true)

    setSessionCompacting('s1', false)

    expect(getInflightTurn('s1')?.compacting).toBe(false)
  })

  it('ignores an empty key', () => {
    setSessionCompacting('', true)
    setSessionCompacting(null, true)

    expect($compactingSessions.get()).toEqual({})
  })
})

describe('routeCompactionEvent', () => {
  it('starts on status.update{compacting} and ends on {compacted}', () => {
    routeCompactionEvent('s1', 'status.update', status('compacting'))

    expect(sessionCompacting('s1').get()).toBe(true)
    expect(turnCompacted('s1')).toBe(true)

    routeCompactionEvent('s1', 'status.update', status('compacted'))

    expect(sessionCompacting('s1').get()).toBe(false)
  })

  // Mid-turn compaction emits no second message.start and no "compacted"
  // status, so the first real output is the only end-signal on that path.
  it('ends on the first output when no "compacted" status arrives', () => {
    routeCompactionEvent('s1', 'status.update', status('compacting'))
    routeCompactionEvent('s1', 'message.delta', {})

    expect(sessionCompacting('s1').get()).toBe(false)
    // But the turn is still marked as having compacted — that outlives the flag.
    expect(turnCompacted('s1')).toBe(true)
  })

  it('does not treat output on a never-compacted turn as an end-signal', () => {
    routeCompactionEvent('s2', 'message.delta', {})

    expect(turnCompacted('s2')).toBe(false)
    expect($compactingSessions.get()).toEqual({})
  })

  it('clears the whole turn mark on a fresh turn, a completion and an error', () => {
    for (const terminal of ['message.start', 'message.complete', 'error']) {
      routeCompactionEvent('s1', 'status.update', status('compacting'))
      routeCompactionEvent('s1', terminal, {})

      expect(sessionCompacting('s1').get()).toBe(false)
      expect(turnCompacted('s1')).toBe(false)
    }
  })

  it('ignores an unrelated status kind', () => {
    routeCompactionEvent('s1', 'status.update', status('process'))

    expect(sessionCompacting('s1').get()).toBe(false)
  })
})

// A compaction interrupted by a disconnect must not leave the composer
// permanently refusing to steer.
describe('turn settle', () => {
  it('releases the flag however the turn ends', () => {
    beginTurn('s1', { prompt: 'a' })
    routeCompactionEvent('s1', 'status.update', status('compacting'))

    expect(sessionCompacting('s1').get()).toBe(true)

    settleTurn('s1')

    expect(sessionCompacting('s1').get()).toBe(false)
    expect(turnCompacted('s1')).toBe(false)
  })
})
