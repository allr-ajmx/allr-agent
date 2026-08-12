import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('idle')
  }
})

vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn().mockResolvedValue(undefined) }))

import { routeGatewayEvent } from '@/store/event-router'
import { $activeSessionKey, $sessionStates, ensureSessionSlice } from '@/store/session-state-types'
import { $subagentsBySession, allSubagents } from '@/store/subagents'

const event = (type: string, payload: Record<string, unknown>, sid = 's1'): GatewayEvent =>
  ({ type, session_id: sid, payload }) as GatewayEvent

/**
 * The WIRING, not the reducer.
 *
 * `pruneFinishedSessionSubagents` had thorough unit coverage and its only
 * production caller — `case 'message.start'` in the router — had none, so the
 * whole feature could have been deleted from the router with every test still
 * green (MJXHRM-401). Everything here goes through `routeGatewayEvent` with the
 * event shapes `tui_gateway/server.py` actually emits.
 */
describe('event-router → subagent spawn tree', () => {
  beforeEach(() => {
    $subagentsBySession.set({})
    $sessionStates.set({})
    // The router fails closed on a key it has no slice for, so both sessions
    // have to exist before any of them can own a subagent.
    ensureSessionSlice('s1')
    ensureSessionSlice('other-session')
    $activeSessionKey.set('s1')
  })

  const spawn = (id: string, goal: string, sid = 's1') =>
    routeGatewayEvent(event('subagent.start', { subagent_id: id, goal, task_index: 0, task_count: 1 }, sid))

  const finish = (id: string, status: string, sid = 's1') =>
    routeGatewayEvent(event('subagent.complete', { subagent_id: id, status, summary: 'done' }, sid))

  it('records a spawn under the session that owns it, not the active one', () => {
    spawn('bg-1', 'background work', 'other-session')

    expect($subagentsBySession.get()['other-session']?.map(item => item.goal)).toEqual(['background work'])
  })

  it('retires the previous turn’s settled rows at the next message.start', () => {
    spawn('a', 'first')
    finish('a', 'completed')
    spawn('b', 'still going')

    expect(allSubagents($subagentsBySession.get())).toHaveLength(2)

    routeGatewayEvent(event('message.start', {}))

    expect(allSubagents($subagentsBySession.get()).map(item => item.id)).toEqual(['b'])
  })

  // The two terminal statuses the reducer used to read as `running`, driven end
  // to end: the gateway relays them verbatim, so the router path is where a
  // timed-out child either leaves the tree or accumulates in it forever.
  it.each(['timeout', 'error'])('retires a child the gateway ended with status %s', status => {
    spawn('slow', 'takes forever')
    finish('slow', status)

    routeGatewayEvent(event('message.start', {}))

    expect(allSubagents($subagentsBySession.get())).toHaveLength(0)
  })

  it('prunes only the session whose turn started', () => {
    spawn('mine', 'here')
    finish('mine', 'completed')
    spawn('theirs', 'elsewhere', 'other-session')
    finish('theirs', 'completed', 'other-session')

    routeGatewayEvent(event('message.start', {}))

    expect($subagentsBySession.get()['s1']).toEqual([])
    expect($subagentsBySession.get()['other-session']).toHaveLength(1)
  })
})
