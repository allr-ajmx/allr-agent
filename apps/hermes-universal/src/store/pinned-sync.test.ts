import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pinnedSessionIds } from './layout'
import {
  applyRemotePinnedSessions,
  resetPinnedSessionSync,
  startPinnedSessionSync,
  syncPinnedSessions
} from './pinned-sync'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('pinned session sync', () => {
  beforeEach(() => {
    resetPinnedSessionSync()
    $pinnedSessionIds.set([])
  })

  afterEach(() => {
    resetPinnedSessionSync()
    $pinnedSessionIds.set([])
  })

  it('adopts the gateway list on connect', async () => {
    const request = vi.fn().mockResolvedValue({ value: ['a', 'b'] })

    await syncPinnedSessions(request)

    expect(request).toHaveBeenCalledWith('config.get', { key: 'pinned_sessions' })
    expect($pinnedSessionIds.get()).toEqual(['a', 'b'])
  })

  // The one-time migration off localStorage: an empty gateway must not delete
  // pins the user already has locally.
  it('pushes local pins up when the gateway has none', async () => {
    $pinnedSessionIds.set(['local-1'])

    const request = vi.fn(async (method: string) => (method === 'config.get' ? { value: [] } : { value: ['local-1'] }))

    await syncPinnedSessions(request)

    expect(request).toHaveBeenCalledWith('config.set', { key: 'pinned_sessions', value: ['local-1'] })
    expect($pinnedSessionIds.get()).toEqual(['local-1'])
  })

  // A gateway too old to know the key answers with no `value` — which is
  // indistinguishable from "no pins", so local pins must survive.
  it('keeps local pins against a gateway that does not know the key', async () => {
    $pinnedSessionIds.set(['local-1'])
    const request = vi.fn().mockResolvedValue({})

    await syncPinnedSessions(request)

    expect($pinnedSessionIds.get()).toEqual(['local-1'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('mirrors a local pin up to the gateway', async () => {
    const request = vi.fn().mockResolvedValue({ value: ['a'] })
    startPinnedSessionSync(request)

    $pinnedSessionIds.set(['a'])
    await flush()

    expect(request).toHaveBeenCalledWith('config.set', { key: 'pinned_sessions', value: ['a'] })
  })

  it('does not echo a list that came from the gateway back to it', async () => {
    const request = vi.fn().mockResolvedValue({ value: ['a'] })
    startPinnedSessionSync(request)

    applyRemotePinnedSessions(['a'])
    await flush()

    expect($pinnedSessionIds.get()).toEqual(['a'])
    expect(request).not.toHaveBeenCalled()
  })

  it('reverts to the confirmed list when the write fails', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'config.get') {
        return { value: ['a'] }
      }

      throw new Error('gateway down')
    })

    await syncPinnedSessions(request)
    startPinnedSessionSync(request)

    $pinnedSessionIds.set(['a', 'b'])
    await flush()

    expect($pinnedSessionIds.get()).toEqual(['a'])
  })

  it('drops blanks and duplicates from an untrusted remote list', () => {
    applyRemotePinnedSessions(['a', '', 'a', '  b  ', null])

    expect($pinnedSessionIds.get()).toEqual(['a', 'b'])
  })
})
