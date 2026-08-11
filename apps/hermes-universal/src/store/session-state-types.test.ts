/**
 * The leaf's write path — specifically the ORDER `rekeySession` does things in.
 *
 * `rekeySession` promises that no subscriber ever observes a frame where the
 * session exists under neither key. The map half of that promise was always
 * kept; the INDEX half was not, and the index is what every surface addresses a
 * session by (MJXHRM-308).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  $sessionStates,
  clearStoredIdIndex,
  emptySessionState,
  publishSessionState,
  rekeySession,
  runtimeKeyForStoredSession
} from '@/store/session-state-types'

beforeEach(() => {
  $sessionStates.set({})
  clearStoredIdIndex()
})

describe('rekeySession', () => {
  it('has the stored-id index consistent BEFORE it publishes the move', () => {
    publishSessionState('runtime-1', { ...emptySessionState('stored-1'), runtimeSessionId: 'runtime-1' })

    const resolvedDuringPublish: Array<null | string> = []

    const unsubscribe = $sessionStates.subscribe(() => {
      resolvedDuringPublish.push(runtimeKeyForStoredSession('stored-1'))
    })

    rekeySession('runtime-1', 'runtime-2', { runtimeSessionId: 'runtime-2' })
    unsubscribe()

    // `$sessionStates.set` notifies SYNCHRONOUSLY, and the reverse index is not
    // an atom — it is a plain map that those subscribers consult. Remapping it
    // after the publish meant every lookup made from inside the notification
    // resolved to the OLD key, found it missing, and took
    // `runtimeKeyForStoredSession`'s self-healing branch, which DELETES the
    // entry. `tileRuntimeKey` / `bubbleRuntimeKey` / `$focusedRuntimeId` are
    // memoized computeds, so each latched its dead-key fallback and did not
    // recompute until some unrelated write touched the map again — a tile
    // recovered while idle simply went blank.
    expect(resolvedDuringPublish.at(-1)).toBe('runtime-2')
    expect(resolvedDuringPublish).not.toContain(null)
  })

  it('carries lineage aliases across the move', () => {
    publishSessionState('runtime-1', { ...emptySessionState('stored-old'), runtimeSessionId: 'runtime-1' })
    // A compaction rotated the stored id; the pre-rotation id stays an alias.
    publishSessionState('runtime-1', {
      ...emptySessionState('stored-new'),
      runtimeSessionId: 'runtime-1'
    })

    rekeySession('runtime-1', 'runtime-2', { runtimeSessionId: 'runtime-2' })

    expect(runtimeKeyForStoredSession('stored-new')).toBe('runtime-2')
    expect(runtimeKeyForStoredSession('stored-old')).toBe('runtime-2')
  })
})
