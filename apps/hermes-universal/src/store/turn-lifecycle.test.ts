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
  adoptResumedTurn,
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
  resumedTurnIsLive,
  routeTurnEvent,
  settleTurn,
  setTurnCompacting,
  STALE_TURN_MS
} from '@/store/turn-lifecycle'
import type { SessionInfo, SessionResumeResponse } from '@/types/hermes'

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

  // A MoA fan-out emits NOTHING but `moa.progress` until every advisor returns,
  // against a `moa_reference` timeout that defaults to 900s. With only
  // `moa.reference` counted, a turn that had been reporting progress for a
  // quarter of an hour still read as "produced nothing" and its `lastEventAt`
  // never moved off `message.start`.
  it.each(['moa.progress', 'moa.phase', 'moa.aggregating', 'moa.reference'])(
    'counts %s as output the turn produced',
    type => {
      const started = applyTurnEvent(beginTurn('s1', { prompt: 'x' }), event('message.start'), 1_000)!

      expect(started.producedOutput).toBe(false)

      const after = applyTurnEvent(started, event(type), 500_000)!

      expect(after.producedOutput).toBe(true)
      expect(after.lastEventAt).toBe(500_000)
    }
  )
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

      // A WARM reconnect re-claims the SAME live record (`_claim_or_reuse_live`),
      // so the runtime id comes back unchanged.
      return { message_count: 0, messages: [], resumed: 'stored-1', running: false, session_id: 'runtime-1' }
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

  // Every other resume scopes itself to the session's owning profile; this one
  // did not, so a multi-profile gateway looked the id up in its launch
  // profile's state.db. The owner comes off the loaded row when it is known.
  it("scopes the resume to the session's owning profile", async () => {
    const requestGateway = vi.fn(async () => ({ message_count: 0, messages: [], running: false, session_id: 'runtime-10' }))

    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      addGatewayEventListener: () => () => {},
      requestGateway
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const session = await import('@/store/session')
    const lifecycle = await import('@/store/turn-lifecycle')

    session.$sessions.set([{ id: 'stored-10', profile: 'research' } as unknown as SessionInfo])
    states.publishSessionState('runtime-10', { ...emptySessionState('stored-10'), runtimeSessionId: 'runtime-10' })
    lifecycle.beginTurn('runtime-10', { prompt: 'a' })

    await lifecycle.reconcileSessionTurn('runtime-10')

    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-10',
      omit_messages: true,
      source: 'universal',
      profile: 'research'
    })

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

  // The plan used to be written to `$inflightTurns` and nowhere else, so the
  // SURFACE — a tile, a bubble, the main chat — kept whatever `busy` it held at
  // the drop. Settling a turn the gateway has forgotten while leaving the slice
  // busy is the "spins forever behind a stop button that does nothing" failure;
  // the layer exists to make a reconnect reconcile what the user sees, not a
  // record nothing renders (MJXHRM-356).
  it('clears the busy a settled reconnect would otherwise strand', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({ message_count: 0, messages: [], running: false, session_id: 'runtime-6' }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-6', {
      ...emptySessionState('stored-6'),
      runtimeSessionId: 'runtime-6',
      awaitingResponse: true,
      busy: true,
      streamId: 'assistant-stream-1',
      turnStartedAt: 1
    })
    lifecycle.beginTurn('runtime-6', { prompt: 'go' })

    await lifecycle.reconcileSessionTurn('runtime-6')

    expect(states.$sessionStates.get()['runtime-6']).toMatchObject({
      awaitingResponse: false,
      busy: false,
      streamId: null,
      turnStartedAt: null
    })

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })

  it('re-arms the busy a reconnect cleared on a turn the gateway is still running', async () => {
    // `invalidateRuntimeBindings` clears every slice's `busy` on the SAME `open`
    // edge that starts this probe, and the only thing that used to put it back
    // was `session.active_list` — which an older gateway does not serve and
    // which trails a poll behind. The tile rendered an idle composer over a
    // streaming turn until the next token happened to land.
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({
        message_count: 0,
        messages: [],
        running: true,
        session_id: 'runtime-7',
        inflight: { user: 'keep going', assistant: '', streaming: true }
      }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-7', {
      ...emptySessionState('stored-7'),
      runtimeSessionId: 'runtime-7',
      busy: false,
      turnStartedAt: null
    })
    lifecycle.beginTurn('runtime-7', { prompt: 'keep going' })

    await lifecycle.reconcileSessionTurn('runtime-7')

    expect(states.$sessionStates.get()['runtime-7'].busy).toBe(true)
    expect(states.$sessionStates.get()['runtime-7'].turnStartedAt).not.toBeNull()

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })

  // MJXHRM-358: `reconcileLiveTail` existed but its only caller — the cold-open
  // rekey — has nothing streaming by construction, so live-tail reconciliation
  // never ran against an in-progress turn. A reconnect is the case it was
  // written for: the slice holds structure that exists nowhere else, and the
  // gateway holds everything the turn said while the socket was down.
  it('folds the inflight snapshot into a STREAMING tail on reconnect', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({
        message_count: 0,
        messages: [],
        running: true,
        session_id: 'runtime-3',
        inflight: { user: 'do the thing', assistant: 'partial answer, continued', streaming: true }
      }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-3', {
      ...emptySessionState('stored-3'),
      runtimeSessionId: 'runtime-3',
      busy: true,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do the thing' }] },
        {
          id: 'a1',
          role: 'assistant',
          pending: true,
          parts: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'partial answer' }
          ]
        }
      ]
    })
    lifecycle.beginTurn('runtime-3', { prompt: 'do the thing' })

    await lifecycle.reconcileSessionTurn('runtime-3')

    const messages = states.$sessionStates.get()['runtime-3'].messages
    const assistants = messages.filter(message => message.role === 'assistant')

    // ONE assistant row, not the local partial sandwiched beside the dump.
    expect(assistants).toHaveLength(1)
    // The reasoning only the local slice had survives…
    expect(assistants[0].parts.some(part => part.type === 'reasoning')).toBe(true)
    // …and the text the gateway saw while we were offline replaces the prefix.
    expect(assistants[0].parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([
      'partial answer, continued'
    ])
    // The user turn is not rendered twice by the projection.
    expect(messages.filter(message => message.role === 'user')).toHaveLength(1)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })

  // MJXHRM-358, the other half. The fold is computed after the resume round
  // trip precisely BECAUSE the router keeps streaming into the slice while it is
  // in the air — so on a plain prose answer (no reasoning, no tools) the local
  // row is regularly AHEAD of the snapshot it is paired with. The merge used to
  // bail out with nothing to carry, leaving the gateway's shorter dump as the
  // paired row and appending our longer copy beside it: the answer printed
  // twice, once truncated.
  it('does not double-print an UNSTRUCTURED tail that streamed past the snapshot', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({
        message_count: 0,
        messages: [],
        running: true,
        session_id: 'runtime-8',
        inflight: { user: 'explain it', assistant: 'Sure. First', streaming: true }
      }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-8', {
      ...emptySessionState('stored-8'),
      runtimeSessionId: 'runtime-8',
      busy: true,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'explain it' }] },
        {
          id: 'a1',
          role: 'assistant',
          pending: true,
          // Ahead of the snapshot: these tokens landed during the round trip.
          parts: [{ type: 'text', text: 'Sure. First, the socket' }]
        }
      ]
    })
    lifecycle.beginTurn('runtime-8', { prompt: 'explain it' })

    await lifecycle.reconcileSessionTurn('runtime-8')

    const messages = states.$sessionStates.get()['runtime-8'].messages
    const assistants = messages.filter(message => message.role === 'assistant')

    expect(assistants).toHaveLength(1)
    // …and it is the LONGER copy that survives, not the snapshot's prefix.
    expect(assistants[0].parts.filter(part => part.type === 'text').map(part => part.text)).toEqual([
      'Sure. First, the socket'
    ])
    // The row is still the live tail, so the next delta keeps landing in it.
    expect(assistants[0].pending).toBe(true)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })

  // A turn that failed while the socket was down has no terminal frame to
  // replay: `_fail_inflight_turn`'s retained snapshot is the only copy. The plan
  // settles the record; the tail fold is what puts the failure on screen.
  it('surfaces a failure the gateway retained while we were offline', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({
        message_count: 0,
        messages: [],
        running: false,
        session_id: 'runtime-9',
        inflight: { user: 'do it', assistant: 'I started to', error: 'provider connection reset', streaming: false }
      }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-9', {
      ...emptySessionState('stored-9'),
      runtimeSessionId: 'runtime-9',
      busy: true,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do it' }] },
        { id: 'a1', role: 'assistant', pending: true, parts: [{ type: 'text', text: 'I started to' }] }
      ]
    })
    lifecycle.beginTurn('runtime-9', { prompt: 'do it' })

    const plan = await lifecycle.reconcileSessionTurn('runtime-9')

    expect(plan).toEqual({ action: 'fail', error: 'provider connection reset' })

    const messages = states.$sessionStates.get()['runtime-9'].messages
    const assistants = messages.filter(message => message.role === 'assistant')

    expect(assistants).toHaveLength(1)
    expect(assistants[0].error).toBe('provider connection reset')
    // Not left spinning behind an error nothing can clear.
    expect(assistants[0].pending).toBe(false)
    expect(states.$sessionStates.get()['runtime-9'].busy).toBe(false)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })

  it('does not re-project a tail onto a turn the gateway has forgotten', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({ message_count: 0, messages: [], running: false, session_id: 'runtime-4' }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    const messages = [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'go' }] }]

    states.publishSessionState('runtime-4', {
      ...emptySessionState('stored-4'),
      runtimeSessionId: 'runtime-4',
      messages
    })
    lifecycle.beginTurn('runtime-4', { prompt: 'go' })

    await lifecycle.reconcileSessionTurn('runtime-4')

    expect(lifecycle.isTurnLive('runtime-4')).toBe(false)
    expect(states.$sessionStates.get()['runtime-4'].messages).toBe(messages)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })
})

describe('reconcileSessionTurn on a RESTARTED gateway', () => {
  // A supervised local backend that died and came back mints a fresh runtime id
  // for the conversation, and this probe is what claims it. The router addresses
  // slices by the id the gateway stamps on each frame, so a slice left under the
  // dead id receives nothing — the probe would re-arm a turn whose entire stream
  // is then dropped.
  it('rebinds the slice onto the runtime id the resume issued', async () => {
    vi.doMock('@/store/gateway', () => ({
      $gatewayState: { get: () => 'open', subscribe: () => () => {} },
      requestGateway: vi.fn(async () => ({
        message_count: 0,
        messages: [],
        resumed: 'stored-5',
        running: true,
        session_id: 'runtime-5-new',
        inflight: { user: 'keep going', assistant: '', streaming: true }
      }))
    }))

    vi.resetModules()
    const states = await import('@/store/session-state-types')
    const lifecycle = await import('@/store/turn-lifecycle')

    states.publishSessionState('runtime-5-old', {
      ...emptySessionState('stored-5'),
      runtimeSessionId: null,
      busy: true
    })
    lifecycle.beginTurn('runtime-5-old', { prompt: 'keep going' })

    await lifecycle.reconcileSessionTurn('runtime-5-old')

    const map = states.$sessionStates.get()

    expect(Object.keys(map)).toEqual(['runtime-5-new'])
    expect(map['runtime-5-new'].runtimeSessionId).toBe('runtime-5-new')
    // The turn followed its slice rather than stranding under the dead key.
    expect(lifecycle.getInflightTurn('runtime-5-old')).toBeNull()
    expect(lifecycle.isTurnLive('runtime-5-new')).toBe(true)

    vi.doUnmock('@/store/gateway')
    vi.resetModules()
  })
})

describe('resumedTurnIsLive', () => {
  const base = { message_count: 0, messages: [], resumed: 'stored', session_id: 'r' }

  it('reads a streaming inflight snapshot', () => {
    expect(
      resumedTurnIsLive({ ...base, running: false, inflight: { user: 'x', streaming: true } } as SessionResumeResponse)
    ).toBe(true)
  })

  // The cold branches report `running: false, status: "idle"` while the kickoff
  // thread is still waiting on a deferred agent build (up to 120s). The turn is
  // already owned over there.
  it('treats a scheduled crash continuation as live', () => {
    expect(
      resumedTurnIsLive({
        ...base,
        running: false,
        auto_continue: { attempt: 1, interrupted_at: 0 }
      } as SessionResumeResponse)
    ).toBe(true)
  })

  it('stays false for an idle session', () => {
    expect(resumedTurnIsLive({ ...base, running: false } as SessionResumeResponse)).toBe(false)
  })

  // A retained failed turn is NOT live — its terminal frame was simply lost.
  it('stays false for a retained failed turn', () => {
    expect(
      resumedTurnIsLive({
        ...base,
        running: false,
        inflight: { user: 'x', error: 'boom', status: 'error', streaming: false }
      } as SessionResumeResponse)
    ).toBe(false)
  })
})

describe('adoptResumedTurn', () => {
  const base = { message_count: 0, messages: [], resumed: 'stored', session_id: 'r' }

  it('adopts the turn a cold resume is auto-continuing, under its interrupted prompt', () => {
    const plan = adoptResumedTurn('s1', {
      ...base,
      running: false,
      auto_continue: { attempt: 2, interrupted_at: 1_000 },
      // The cold branches fill this from the crash marker.
      inflight: { user: 'fix the flaky test', assistant: '', streaming: true }
    } as SessionResumeResponse)

    expect(plan).toEqual({ action: 'adopt', origin: 'auto-continue', prompt: 'fix the flaky test', attempts: 2 })
    expect(getInflightTurn('s1')).toMatchObject({
      origin: 'auto-continue',
      prompt: 'fix the flaky test',
      attempts: 2,
      phase: 'submitted'
    })
  })

  it('adopts a turn already streaming somewhere else', () => {
    adoptResumedTurn('s1', {
      ...base,
      running: true,
      inflight: { user: 'other surface', assistant: 'partial', streaming: true }
    } as SessionResumeResponse)

    expect(getInflightTurn('s1')).toMatchObject({ origin: 'remote', prompt: 'other surface' })
  })

  it('records nothing for an idle session', () => {
    expect(adoptResumedTurn('s1', { ...base, running: false } as SessionResumeResponse)).toEqual({ action: 'noop' })
    expect(getInflightTurn('s1')).toBeNull()
  })

  // Two resumes in a row each return the descriptor for the SAME scheduled
  // continuation; adopting twice must not open a second turn.
  it('is idempotent across a repeated resume', () => {
    const resumed = {
      ...base,
      running: false,
      auto_continue: { attempt: 1, interrupted_at: 0 },
      inflight: { user: 'go', assistant: '', streaming: true }
    } as SessionResumeResponse

    adoptResumedTurn('s1', resumed)
    const first = getInflightTurn('s1')
    adoptResumedTurn('s1', resumed)

    expect(getInflightTurn('s1')).toBe(first)
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
