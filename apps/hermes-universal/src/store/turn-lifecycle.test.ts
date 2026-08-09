import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'
import { clearSessionClarify, sessionClarifyRequest, setSessionClarify } from '@/store/prompts'
import {
  $activeSessionKey,
  $sessionStates,
  emptySessionState,
  publishSessionState,
  rekeySession
} from '@/store/session-state-types'
import {
  $inflightTurns,
  applyTurnEvent,
  applyTurnReconciliation,
  beginTurn,
  clearAllTurns,
  getInflightTurn,
  type InflightTurn,
  isTurnLive,
  observeTurnLifecycle,
  planTurnReconciliation,
  recordTurnCorrection,
  remoteTurnSnapshot,
  type RemoteTurnSnapshot,
  routeTurnEvent,
  settleTurn,
  setTurnCompacting,
  STALE_TURN_MS
} from '@/store/turn-lifecycle'
import type { SessionResumeResponse } from '@/types/hermes'

const event = (type: string): GatewayEvent => ({ type }) as GatewayEvent

const remote = (patch: Partial<RemoteTurnSnapshot> = {}): RemoteTurnSnapshot => ({
  running: false,
  streaming: false,
  user: '',
  corrections: [],
  error: '',
  autoContinue: null,
  ...patch
})

beforeEach(() => {
  clearAllTurns()
  $sessionStates.set({})
  $activeSessionKey.set('s1')
})

describe('applyTurnEvent', () => {
  it('adopts a turn the gateway starts on its own', () => {
    const turn = applyTurnEvent(null, event('message.start'))

    expect(turn).toMatchObject({ phase: 'streaming', origin: 'remote', acknowledged: true })
  })

  it('acknowledges a locally-submitted turn rather than replacing it', () => {
    const submitted = beginTurn('s1', { prompt: 'hello' })
    const turn = applyTurnEvent(submitted, event('message.start'))

    expect(turn).toMatchObject({ turnId: submitted.turnId, phase: 'streaming', prompt: 'hello', acknowledged: true })
  })

  it('parks on a blocking prompt and resumes on the next delta', () => {
    const parked = applyTurnEvent(beginTurn('s1', { prompt: 'q' }), event('clarify.request'))!

    expect(parked.phase).toBe('awaiting-input')
    expect(applyTurnEvent(parked, event('message.delta'))!.phase).toBe('streaming')
  })

  // Every token is an output event. A fresh record per token would republish the
  // atom at delta rate, which is the re-render storm lib/stream-batch exists to
  // avoid.
  it('does not republish the record for every delta', () => {
    const started = applyTurnEvent(beginTurn('s1', { prompt: 'x' }), event('message.start'))!
    const first = applyTurnEvent(started, event('message.delta'), 1_000)!

    expect(first).not.toBe(started)
    expect(applyTurnEvent(first, event('message.delta'), 1_100)).toBe(first)
    expect(applyTurnEvent(first, event('message.delta'), 2_500)).not.toBe(first)
  })

  it('ignores events for a settled turn', () => {
    const settled = applyTurnEvent(beginTurn('s1', { prompt: 'x' }), event('message.complete'))!

    expect(settled.phase).toBe('settled')
    expect(applyTurnEvent(settled, event('message.delta'))).toBe(settled)
  })
})

describe('the store', () => {
  it('tracks liveness per session', () => {
    beginTurn('s1', { prompt: 'a' })

    expect(isTurnLive('s1')).toBe(true)
    expect(isTurnLive('s2')).toBe(false)

    settleTurn('s1')

    expect(isTurnLive('s1')).toBe(false)
  })

  it('appends corrections without touching the prompt', () => {
    beginTurn('s1', { prompt: 'original' })
    recordTurnCorrection('s1', 'actually do this')
    recordTurnCorrection('s1', '  ')

    expect(getInflightTurn('s1')).toMatchObject({ prompt: 'original', corrections: ['actually do this'] })
  })

  it('publishes transitions to observers', () => {
    const seen: string[] = []
    const dispose = observeTurnLifecycle(e => seen.push(e.transition))

    beginTurn('s1', { prompt: 'a' })
    setTurnCompacting('s1', true)
    setTurnCompacting('s1', false)
    routeTurnEvent('s1', event('message.complete'))
    dispose()

    expect(seen).toEqual(['begin', 'compaction-start', 'compaction-end', 'settle'])
  })

  it('isolates a throwing observer', () => {
    const dispose = observeTurnLifecycle(() => {
      throw new Error('boom')
    })

    expect(() => beginTurn('s1', { prompt: 'a' })).not.toThrow()
    dispose()
  })

  // A draft rekeys onto its runtime id mid-submit; a record left under the draft
  // key is a turn nothing can ever settle.
  it('follows its session across a rekey', () => {
    publishSessionState('draft:1', emptySessionState())
    beginTurn('draft:1', { prompt: 'a' })
    rekeySession('draft:1', 'runtime-1', { runtimeSessionId: 'runtime-1' })

    expect(getInflightTurn('draft:1')).toBeNull()
    expect(getInflightTurn('runtime-1')).toMatchObject({ prompt: 'a' })
  })
})

describe('hydration safety', () => {
  // The agent is parked in `_block` waiting on clarify.respond. A request left
  // under the pre-resume key is unanswerable: the panel reads the live key and
  // finds nothing, and the turn hangs until the tool's own timeout.
  it('carries a pending clarify across a runtime-id rotation', () => {
    publishSessionState('hydrating:stored-1', emptySessionState('stored-1'))
    setSessionClarify('hydrating:stored-1', { requestId: 'req-1', question: 'which?', choices: ['a', 'b'] })

    rekeySession('hydrating:stored-1', 'runtime-9', { runtimeSessionId: 'runtime-9' })

    expect(sessionClarifyRequest('runtime-9').get()).toMatchObject({ requestId: 'req-1' })
    expect(sessionClarifyRequest('hydrating:stored-1').get()).toBeNull()

    clearSessionClarify('runtime-9')
  })
})

describe('remoteTurnSnapshot', () => {
  it('reads the inflight snapshot, corrections and auto-continue descriptor', () => {
    const resumed = {
      inflight: { assistant: 'partial', corrections: ['fix it', '  '], streaming: true, user: 'do a thing' },
      auto_continue: { attempt: 2, interrupted_at: 1_700_000 },
      message_count: 0,
      messages: [],
      resumed: 'stored-1',
      session_id: 'runtime-1'
    } as unknown as SessionResumeResponse

    expect(remoteTurnSnapshot(resumed)).toEqual({
      running: true,
      streaming: true,
      user: 'do a thing',
      corrections: ['fix it'],
      error: '',
      autoContinue: { attempt: 2, interruptedAt: 1_700_000 }
    })
  })

  it('reads an older gateway that omits everything', () => {
    const resumed = { message_count: 0, messages: [], resumed: 's', session_id: 'r' } as SessionResumeResponse

    expect(remoteTurnSnapshot(resumed)).toMatchObject({ running: false, autoContinue: null, corrections: [] })
  })
})

describe('planTurnReconciliation', () => {
  const live = (patch: Partial<InflightTurn> = {}): InflightTurn => ({
    turnId: 't1',
    phase: 'submitted',
    origin: 'local',
    prompt: 'do a thing',
    corrections: [],
    startedAt: 1_000,
    lastEventAt: 1_000,
    acknowledged: false,
    producedOutput: false,
    compacting: false,
    attempts: 0,
    ...patch
  })

  it('keeps a turn both sides agree is running, adopting only unseen corrections', () => {
    const plan = planTurnReconciliation(
      live({ corrections: ['fix it'] }),
      remote({ running: true, streaming: true, corrections: ['fix it', 'and this'] }),
      1_000
    )

    expect(plan).toEqual({ action: 'keep', corrections: ['and this'] })
  })

  it('adopts a turn the gateway is running that we have no record of', () => {
    expect(planTurnReconciliation(null, remote({ running: true, user: 'from another surface' }), 1_000)).toEqual({
      action: 'adopt',
      origin: 'remote',
      prompt: 'from another surface',
      attempts: 0
    })
  })

  // The terminal frame died with the socket. Believing our own record forever is
  // how a chat spins on a stopped turn.
  it('settles a local turn the gateway says is idle', () => {
    expect(planTurnReconciliation(live(), remote(), 1_000)).toEqual({ action: 'settle', reason: 'remote-idle' })
  })

  it('surfaces a retained failed turn over everything else', () => {
    expect(planTurnReconciliation(live(), remote({ running: true, error: 'provider exploded' }), 1_000)).toEqual({
      action: 'fail',
      error: 'provider exploded'
    })
  })

  it('settles an unacknowledged turn that has gone quiet past the staleness window', () => {
    const now = 1_000 + STALE_TURN_MS + 1

    expect(planTurnReconciliation(live(), remote({ running: true }), now)).toEqual({
      action: 'settle',
      reason: 'stale'
    })
  })

  it('does not call an ACKNOWLEDGED long-running turn stale', () => {
    const now = 1_000 + STALE_TURN_MS + 1

    const plan = planTurnReconciliation(
      live({ acknowledged: true, phase: 'streaming' }),
      remote({ running: true }),
      now
    )

    expect(plan).toMatchObject({ action: 'keep' })
  })

  it('does nothing when neither side has a turn', () => {
    expect(planTurnReconciliation(null, remote(), 1_000)).toEqual({ action: 'noop' })
    expect(planTurnReconciliation(live({ phase: 'settled' }), remote(), 1_000)).toEqual({ action: 'noop' })
  })

  // The gateway already scheduled the re-run (`_maybe_schedule_auto_continue`).
  // Resubmitting here is how the same prompt runs twice.
  it('adopts the gateway-scheduled auto-continue instead of resubmitting', () => {
    const plan = planTurnReconciliation(
      live({ prompt: 'the interrupted request' }),
      remote({ autoContinue: { attempt: 1, interruptedAt: 500 } }),
      1_000
    )

    expect(plan).toEqual({ action: 'adopt', origin: 'auto-continue', prompt: 'the interrupted request', attempts: 1 })
  })
})

describe('applyTurnReconciliation', () => {
  it('merges only the corrections the plan named', () => {
    beginTurn('s1', { prompt: 'a' })
    recordTurnCorrection('s1', 'one')
    applyTurnReconciliation('s1', { action: 'keep', corrections: ['two'] })

    expect(getInflightTurn('s1')?.corrections).toEqual(['one', 'two'])
  })

  // Two resumes in a row each return the descriptor for the SAME scheduled
  // continuation. Adopting twice would open two turns for one re-run.
  it('is idempotent across a double resume of the same auto-continue', () => {
    const plan = { action: 'adopt', origin: 'auto-continue', prompt: 'a', attempts: 1 } as const

    applyTurnReconciliation('s1', plan)
    const first = getInflightTurn('s1')
    applyTurnReconciliation('s1', plan)

    expect(getInflightTurn('s1')).toBe(first)
  })

  it('opens a NEW turn when the gateway escalated to the next attempt', () => {
    applyTurnReconciliation('s1', { action: 'adopt', origin: 'auto-continue', prompt: 'a', attempts: 1 })
    const first = getInflightTurn('s1')
    applyTurnReconciliation('s1', { action: 'adopt', origin: 'auto-continue', prompt: 'a', attempts: 2 })

    expect(getInflightTurn('s1')).not.toBe(first)
    expect(getInflightTurn('s1')?.attempts).toBe(2)
  })

  it('carries corrections onto an adopted turn', () => {
    beginTurn('s1', { prompt: 'a' })
    recordTurnCorrection('s1', 'fix it')
    applyTurnReconciliation('s1', { action: 'adopt', origin: 'remote', prompt: 'a', attempts: 0 })

    expect(getInflightTurn('s1')?.corrections).toEqual(['fix it'])
  })

  it('settles on fail and on settle', () => {
    beginTurn('s1', { prompt: 'a' })
    applyTurnReconciliation('s1', { action: 'fail', error: 'boom' })

    expect(isTurnLive('s1')).toBe(false)

    beginTurn('s2', { prompt: 'a' })
    applyTurnReconciliation('s2', { action: 'settle', reason: 'remote-idle' })

    expect(isTurnLive('s2')).toBe(false)
  })
})

describe('reconcileSessionTurn', () => {
  it('issues ONE resume per session even when two reconnects race', async () => {
    const requestGateway = vi.fn(async () => {
      await Promise.resolve()

      return { message_count: 0, messages: [], resumed: 'stored-1', running: false, session_id: 'r' }
    })

    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway
    }))

    // A fresh module graph, so the module-level "already reconciling" guard
    // starts clean — and the slice has to be seeded in THAT graph's atom.
    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-1', { ...emptySessionState('stored-1'), runtimeSessionId: 'runtime-1' })
    lifecycle.beginTurn('runtime-1', { prompt: 'a' })

    await Promise.all([lifecycle.reconcileSessionTurn('runtime-1'), lifecycle.reconcileSessionTurn('runtime-1')])

    expect(requestGateway).toHaveBeenCalledTimes(1)
    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-1',
      omit_messages: true,
      source: 'universal'
    })
    // Gateway says idle → the turn we thought was live is settled, not stranded.
    expect(lifecycle.isTurnLive('runtime-1')).toBe(false)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })

  it('leaves the record alone when the probe itself fails', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(() => Promise.reject(new Error('socket down')))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-2', { ...emptySessionState('stored-2'), runtimeSessionId: 'runtime-2' })
    lifecycle.beginTurn('runtime-2', { prompt: 'a' })

    expect(await lifecycle.reconcileSessionTurn('runtime-2')).toBeNull()
    expect(lifecycle.isTurnLive('runtime-2')).toBe(true)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })
})

describe('$inflightTurns', () => {
  it('drops a settled session on teardown', () => {
    beginTurn('s1', { prompt: 'a' })

    expect(Object.keys($inflightTurns.get())).toEqual(['s1'])

    clearAllTurns()

    expect($inflightTurns.get()).toEqual({})
  })
})
