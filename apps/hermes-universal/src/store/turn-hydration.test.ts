import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `store/turn-hydration` pulls in `store/turn-lifecycle`, which imports the
// gateway client. Neither the socket nor the RPC is under test here.
vi.mock('@/store/gateway', () => ({
  $gatewayState: atom('open'),
  requestGateway: vi.fn()
}))

import '@/store/turn-hydration'

import type { ChatMessage } from '@/lib/chat-messages'
import {
  __resetInFlightTurnJournalCache,
  persistInFlightTurnState,
  readInFlightTurnJournal
} from '@/lib/inflight-turn-journal'
import {
  $sessionStates,
  ensureSessionSlice,
  hydratingKey,
  rekeySession,
  updateSession
} from '@/store/session-state-types'

// A session recovers ONCE per process, so every test needs its own stored id —
// otherwise the second one silently measures the guard instead of the fold.
let seq = 0
let stored = ''
let runtime = ''

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })

const streaming = (id: string): ChatMessage => ({
  id,
  role: 'assistant',
  pending: true,
  parts: [
    { type: 'reasoning', text: 'weighing it up' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'terminal', args: {} },
    { type: 'text', text: 'half an ans' }
  ]
})

/** The state the journal saw the instant before the process died: a live turn
 *  with a prompt and a streaming reply carrying structure. */
function journalALiveTurn(): void {
  vi.useFakeTimers()

  persistInFlightTurnState({
    awaitingResponse: false,
    busy: true,
    messages: [user('u1', 'do a thing'), streaming('assistant-stream-live')],
    storedSessionId: stored,
    streamId: 'assistant-stream-live',
    turnStartedAt: 1_700_000_000_000
  })

  vi.advanceTimersByTime(500)
  vi.useRealTimers()
}

/** What `store/session.ts#hydrateColdSession` does to the store on a cold open,
 *  reduced to the two writes that matter: the placeholder slice, then the rekey
 *  onto the runtime id carrying the backend's answer. */
function coldOpen(committed: ChatMessage[], stillRunning: boolean): void {
  const key = hydratingKey(stored)

  ensureSessionSlice(key, { storedSessionId: stored, busy: true })
  rekeySession(key, runtime, {
    runtimeSessionId: runtime,
    storedSessionId: stored,
    messages: committed,
    busy: stillRunning
  })
}

const slice = () => $sessionStates.get()[runtime]

beforeEach(() => {
  window.localStorage.clear()
  __resetInFlightTurnJournalCache()
  $sessionStates.set({})
  seq += 1
  stored = `stored-crash-${seq}`
  runtime = `runtime-${seq}`
})

// THE case the ticket exists for: the app is killed mid-turn and the backend
// goes with it, so `session.resume` comes back with nothing running. The whole
// point is that reopening the session shows what the user was watching.
describe('cold open after the app died mid-turn', () => {
  it('recovers the journaled tail onto the committed transcript', () => {
    journalALiveTurn()
    coldOpen([user('u1', 'do a thing')], false)

    expect(slice().messages.map(m => m.id)).toEqual(['u1', 'assistant-stream-live'])
    expect(slice().messages[1].parts.map(p => p.type)).toEqual(['reasoning', 'tool-call', 'text'])
  })

  // The reply is over — nothing will deliver another delta for it. A row left
  // pending renders as a bubble that spins forever beside an idle composer.
  it('seals the recovered reply rather than leaving it streaming', () => {
    journalALiveTurn()
    coldOpen([user('u1', 'do a thing')], false)

    expect(slice().messages[1].pending).toBe(false)
    expect(slice().streamId).toBeNull()
  })

  it('restores the turn clock the journal recorded', () => {
    journalALiveTurn()
    coldOpen([user('u1', 'do a thing')], false)

    expect(slice().turnStartedAt).toBe(1_700_000_000_000)
  })

  // The recovered rows are local-only, so a later open cannot satisfy
  // `caughtUp` — an entry that outlived its fold would replay the same dead
  // turn on every open for the whole seven-day TTL.
  it('spends the entry it folded in', async () => {
    journalALiveTurn()
    coldOpen([user('u1', 'do a thing')], false)
    await Promise.resolve()

    expect(readInFlightTurnJournal(stored)).toBeNull()
  })

  // The backend outlived the crash and is still mid-turn: the row stays live
  // and keeps its entry, because more deltas are coming for it.
  it('keeps a still-running turn streaming, and keeps its entry', async () => {
    journalALiveTurn()
    coldOpen([user('u1', 'do a thing')], true)
    await Promise.resolve()

    expect(slice().messages[1].pending).toBe(true)
    expect(slice().streamId).toBe('assistant-stream-live')
    expect(readInFlightTurnJournal(stored)).not.toBeNull()
  })
})

describe('the journaling pass', () => {
  // A settled session's journal really is spent, and the settle path has to say
  // so — otherwise nothing ever bounds the store.
  it('clears a session whose turn has genuinely finished', async () => {
    journalALiveTurn()
    ensureSessionSlice(runtime, { storedSessionId: stored })
    updateSession(runtime, state => ({ ...state, busy: false, awaitingResponse: false, streamId: null }))
    await Promise.resolve()

    expect(readInFlightTurnJournal(stored)).toBeNull()
  })

  // `$sessionStates` republishes the WHOLE map on every delta. Journaling every
  // session inline on every publish put the bookkeeping for N idle sessions on
  // the token path of the one that is streaming.
  it('does not re-journal a session whose slice did not change', async () => {
    ensureSessionSlice(runtime, { storedSessionId: stored })
    await Promise.resolve()

    const readTarget = (
      typeof Storage !== 'undefined' && window.localStorage instanceof Storage ? Storage.prototype : window.localStorage
    ) as Storage

    const getItem = vi.spyOn(readTarget, 'getItem')

    // Twenty deltas' worth of republishes, none of them this session's.
    for (let i = 0; i < 20; i += 1) {
      ensureSessionSlice(`noise-${seq}-${i}`, {})
      await Promise.resolve()
    }

    expect(getItem).not.toHaveBeenCalled()
    getItem.mockRestore()
  })
})
