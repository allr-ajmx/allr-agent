import { beforeEach, describe, expect, it } from 'vitest'

import {
  $parkedQueueSessions,
  $queuedPromptsBySession,
  enqueueQueuedPrompt,
  isQueueParked,
  migrateQueuedPrompts,
  parkQueuedPrompts,
  removeQueuedPrompt,
  shouldAutoDrain,
  unparkQueuedPrompts
} from './composer-queue'

const queue = (key: string, text: string) => enqueueQueuedPrompt(key, { text, attachments: [] })

beforeEach(() => {
  $queuedPromptsBySession.set({})
  $parkedQueueSessions.set({})
  window.localStorage.clear()
})

describe('queue parking', () => {
  it('holds the auto-drain back once a session is parked', () => {
    queue('s1', 'the follow-up I lined up')

    expect(shouldAutoDrain({ isBusy: false, parked: isQueueParked('s1'), queueLength: 1 })).toBe(true)

    expect(parkQueuedPrompts('s1')).toBe(true)
    expect(isQueueParked('s1')).toBe(true)
    expect(shouldAutoDrain({ isBusy: false, parked: isQueueParked('s1'), queueLength: 1 })).toBe(false)
  })

  it('refuses to park a session with an empty queue, so no stale gate can linger', () => {
    expect(parkQueuedPrompts('s1')).toBe(false)
    expect(isQueueParked('s1')).toBe(false)

    // A prompt queued later must flow: it was never held back by anything.
    queue('s1', 'later')
    expect(shouldAutoDrain({ isBusy: false, parked: isQueueParked('s1'), queueLength: 1 })).toBe(true)
  })

  it('unparks when a fresh prompt is queued — new intent overrides the halt', () => {
    queue('s1', 'first')
    parkQueuedPrompts('s1')

    queue('s1', 'second')

    expect(isQueueParked('s1')).toBe(false)
  })

  it('drops the park when the queue empties out', () => {
    const entry = queue('s1', 'only one')
    parkQueuedPrompts('s1')

    removeQueuedPrompt('s1', entry?.id ?? '')

    expect(isQueueParked('s1')).toBe(false)
  })

  it('re-homes the park with its entries across a runtime re-key', () => {
    queue('old-runtime', 'held back')
    parkQueuedPrompts('old-runtime')

    expect(migrateQueuedPrompts('old-runtime', 'new-runtime')).toBe(true)

    // Without the re-home a backend bounce right after Stop would shed the park
    // and auto-send the exact prompts the user just halted.
    expect(isQueueParked('old-runtime')).toBe(false)
    expect(isQueueParked('new-runtime')).toBe(true)
  })

  it('lifts on an explicit resume', () => {
    queue('s1', 'held back')
    parkQueuedPrompts('s1')

    unparkQueuedPrompts('s1')

    expect(isQueueParked('s1')).toBe(false)
    expect(shouldAutoDrain({ isBusy: false, parked: isQueueParked('s1'), queueLength: 1 })).toBe(true)
  })

  it('parks only the session that was halted', () => {
    queue('s1', 'one')
    queue('s2', 'two')

    parkQueuedPrompts('s1')

    expect(isQueueParked('s1')).toBe(true)
    expect(isQueueParked('s2')).toBe(false)
  })
})
