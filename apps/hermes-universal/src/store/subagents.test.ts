import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $sessionStates, dropSessionState, ensureSessionSlice, rekeySession } from './session-state-types'
import {
  $subagentsBySession,
  activeSubagentCount,
  allSubagents,
  buildSubagentTree,
  clearAllSubagents,
  clearSessionSubagents,
  failedSubagentCount,
  pruneFinishedSessionSubagents,
  upsertSubagent
} from './subagents'

const SID = 's1'

describe('subagents reducer', () => {
  beforeEach(() => {
    $subagentsBySession.set({})
    $sessionStates.set({})
  })
  afterEach(() => {
    $subagentsBySession.set({})
    $sessionStates.set({})
  })

  it('builds a parent/child tree from spawn events', () => {
    upsertSubagent(SID, { subagent_id: 'a', parent_id: null, goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'b', parent_id: 'a', goal: 'child', status: 'running' }, true, 'subagent.start')

    const tree = buildSubagentTree(allSubagents($subagentsBySession.get()))
    expect(tree).toHaveLength(1)
    expect(tree[0].goal).toBe('root')
    expect(tree[0].children.map(c => c.goal)).toEqual(['child'])
  })

  it('does not create an entry for a progress event with an unknown id', () => {
    upsertSubagent(SID, { subagent_id: 'ghost', status: 'running' }, false, 'subagent.progress')
    expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
  })

  it('freezes a subagent once it reaches a terminal status', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'a', status: 'completed', summary: 'done' }, false, 'subagent.complete')
    // A late progress event must not revive it.
    upsertSubagent(SID, { subagent_id: 'a', status: 'running' }, false, 'subagent.progress')

    const [only] = allSubagents($subagentsBySession.get())
    expect(only.status).toBe('completed')
  })

  it('accumulates the stream tail from progress/tool events', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'a', text: 'reading files', status: 'running' }, false, 'subagent.progress')
    const [node] = allSubagents($subagentsBySession.get())
    expect(node.stream.at(-1)?.text).toBe('reading files')
  })

  // "Queued" was never a delivery receipt. The gateway only learns the steer
  // missed its window at completion, so `subagent.complete` is the one and only
  // frame that can retract the promise the Agents overlay already made.
  it('keeps the steer a finished child never delivered', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(
      SID,
      { subagent_id: 'a', status: 'completed', summary: 'done', missed_steer: 'focus on pricing' },
      false,
      'subagent.complete'
    )

    expect(allSubagents($subagentsBySession.get())[0].missedSteer).toBe('focus on pricing')
  })

  it('leaves missedSteer unset for a child that delivered everything', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    upsertSubagent(SID, { subagent_id: 'a', status: 'completed', summary: 'done' }, false, 'subagent.complete')

    expect(allSubagents($subagentsBySession.get())[0].missedSteer).toBeUndefined()
  })

  it('clears one session', () => {
    upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
    clearSessionSubagents(SID)
    expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
  })

  describe('pruneFinishedSessionSubagents', () => {
    it('retires settled rows but keeps work still in flight', () => {
      upsertSubagent(SID, { subagent_id: 'done', goal: 'a', status: 'running' }, true, 'subagent.start')
      upsertSubagent(SID, { subagent_id: 'done', status: 'completed' }, false, 'subagent.complete')
      upsertSubagent(SID, { subagent_id: 'failed', goal: 'b', status: 'running' }, true, 'subagent.start')
      upsertSubagent(SID, { subagent_id: 'failed', status: 'failed' }, false, 'subagent.complete')
      upsertSubagent(SID, { subagent_id: 'live', goal: 'c', status: 'running' }, true, 'subagent.start')
      upsertSubagent(SID, { subagent_id: 'queued', goal: 'd', status: 'queued' }, true, 'subagent.spawn_requested')

      pruneFinishedSessionSubagents(SID)

      expect(
        allSubagents($subagentsBySession.get())
          .map(item => item.id)
          .sort()
      ).toEqual(['live', 'queued'])
    })

    // A background subagent outlives the turn that spawned it, and the prune
    // runs on every `message.start` — so it must keep receiving its events.
    it('leaves a surviving row able to complete on a later turn', () => {
      upsertSubagent(SID, { subagent_id: 'bg', goal: 'long', status: 'running' }, true, 'subagent.start')
      pruneFinishedSessionSubagents(SID)
      upsertSubagent(SID, { subagent_id: 'bg', status: 'completed', summary: 'done' }, false, 'subagent.complete')

      const [only] = allSubagents($subagentsBySession.get())
      expect(only.status).toBe('completed')
      expect(only.summary).toBe('done')
    })

    it('is a no-op for a session with nothing to prune', () => {
      upsertSubagent(SID, { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')
      const before = $subagentsBySession.get()

      pruneFinishedSessionSubagents(SID)
      pruneFinishedSessionSubagents('never-seen')

      expect($subagentsBySession.get()).toBe(before)
    })

    // THE defect the prune was shipped to fix but did not: the gateway's
    // timeout/exception exits relay `status: "timeout"` / `"error"`
    // (tools/delegate_tool.py:2402), which the reducer read as an unknown value
    // and settled on `running` — so the prune kept them, forever.
    it.each(['timeout', 'error'])('retires a child the gateway ended with status %s', status => {
      upsertSubagent(SID, { subagent_id: 'x', goal: 'slow', status: 'running' }, true, 'subagent.start')
      upsertSubagent(SID, { subagent_id: 'x', status, summary: '' }, false, 'subagent.complete')

      const [row] = allSubagents($subagentsBySession.get())
      expect(row.status).toBe('failed')
      expect(activeSubagentCount([row])).toBe(0)
      expect(failedSubagentCount([row])).toBe(1)

      pruneFinishedSessionSubagents(SID)
      expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
    })

    // A timed-out child stops being live, which is what clears its spinner and
    // freezes its elapsed timer — but the reason must survive as the summary
    // line, since the status itself no longer says "timeout".
    it('keeps the timeout reason on the stream once the status collapses to failed', () => {
      upsertSubagent(SID, { subagent_id: 'x', goal: 'slow', status: 'running' }, true, 'subagent.start')
      upsertSubagent(
        SID,
        { subagent_id: 'x', status: 'timeout', text: 'Timed out after 300s', summary: '' },
        false,
        'subagent.complete'
      )

      const [row] = allSubagents($subagentsBySession.get())
      expect(row.currentTool).toBeUndefined()
      expect(row.stream.at(-1)).toMatchObject({ isError: true, kind: 'summary', text: 'Timed out after 300s' })
    })
  })

  /**
   * Scope: the map is keyed by session key and flattened across every session by
   * `allSubagents`, so anything left under a dead key is not inert — the Agents
   * overlay renders it and the status bar counts it.
   */
  describe('session scope', () => {
    it('drops a session’s rows when its slice is evicted', () => {
      ensureSessionSlice('runtime-1')
      upsertSubagent('runtime-1', { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')

      dropSessionState('runtime-1')

      expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
    })

    it('follows the slice across a rekey', () => {
      ensureSessionSlice('draft:1')
      upsertSubagent('draft:1', { subagent_id: 'a', goal: 'root', status: 'running' }, true, 'subagent.start')

      rekeySession('draft:1', 'runtime-1')

      expect($subagentsBySession.get()['draft:1']).toBeUndefined()
      expect($subagentsBySession.get()['runtime-1']?.map(item => item.id)).toEqual(['a'])
    })

    it('merges into rows the destination key already had, without duplicating', () => {
      ensureSessionSlice('draft:1')
      upsertSubagent('draft:1', { subagent_id: 'a', goal: 'moved', status: 'running' }, true, 'subagent.start')
      upsertSubagent('draft:1', { subagent_id: 'c', goal: 'also moved', status: 'running' }, true, 'subagent.start')
      upsertSubagent(
        'runtime-1',
        { subagent_id: 'a', goal: 'already there', status: 'running' },
        true,
        'subagent.start'
      )
      upsertSubagent('runtime-1', { subagent_id: 'b', goal: 'kept', status: 'running' }, true, 'subagent.start')

      rekeySession('draft:1', 'runtime-1')

      expect($subagentsBySession.get()['runtime-1']?.map(item => item.id)).toEqual(['a', 'b', 'c'])
      expect($subagentsBySession.get()['runtime-1']?.find(item => item.id === 'a')?.goal).toBe('already there')
    })

    it('drops every session at once for a profile / gateway switch', () => {
      upsertSubagent('runtime-1', { subagent_id: 'a', goal: 'one', status: 'running' }, true, 'subagent.start')
      upsertSubagent('runtime-2', { subagent_id: 'b', goal: 'two', status: 'running' }, true, 'subagent.start')

      clearAllSubagents()

      expect($subagentsBySession.get()).toEqual({})
    })
  })
})
