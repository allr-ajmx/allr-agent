import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import {
  clearInFlightTurnJournal,
  mergeInFlightMessages,
  persistInFlightTurnState,
  readInFlightTurnJournal,
  recoverableTail,
  recoverInFlightTurnJournal
} from '@/lib/inflight-turn-journal'

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })

const assistant = (id: string, text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
  ...patch
})

const withTool = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'reasoning', text: 'thinking' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'terminal', args: {} }
  ],
  ...patch
})

beforeEach(() => {
  window.localStorage.clear()
})

describe('recoverableTail', () => {
  it('takes the live assistant and the user turn that opened it', () => {
    const tail = recoverableTail([
      user('u0', 'older'),
      assistant('a0', 'older reply'),
      user('u1', 'do a thing'),
      withTool('assistant-stream-1', { pending: true })
    ])

    expect(tail.map(m => m.id)).toEqual(['u1', 'assistant-stream-1'])
  })

  // A mid-turn correction inserts ANOTHER user row right before the live reply,
  // so a turn can open with a RUN of user rows. Stopping at the nearest one
  // journals the correction alone and loses the prompt that started the turn.
  it('walks back over a run of user rows so a correction keeps its prompt', () => {
    const tail = recoverableTail([
      user('u1', 'do a thing'),
      user('u2', 'actually do this'),
      withTool('assistant-stream-1', { pending: true })
    ])

    expect(tail.map(m => m.id)).toEqual(['u1', 'u2', 'assistant-stream-1'])
  })

  it('journals nothing when the turn has produced nothing worth keeping', () => {
    expect(recoverableTail([user('u1', 'do a thing')])).toEqual([])
    expect(recoverableTail([user('u1', 'x'), assistant('a1', '   ', { pending: true })])).toEqual([])
  })

  it('keeps a failed turn, which has no text but is the whole point', () => {
    const tail = recoverableTail([user('u1', 'x'), assistant('a1', '', { error: 'provider exploded' })])

    expect(tail.map(m => m.id)).toEqual(['u1', 'a1'])
  })
})

describe('mergeInFlightMessages', () => {
  const tail = [user('u1', 'do a thing'), withTool('assistant-stream-1', { pending: true })]

  it('appends the whole turn when the base never saw it', () => {
    const result = mergeInFlightMessages([user('u0', 'older'), assistant('a0', 'reply')], tail)

    expect(result.applied).toBe(true)
    expect(result.messages.map(m => m.id)).toEqual(['u0', 'a0', 'u1', 'assistant-stream-1'])
  })

  // The turn finished and committed while we were away — anything the journal
  // still holds is a partial copy of a reply already on screen.
  it('reports caught-up when the base already has a settled reply', () => {
    const result = mergeInFlightMessages([user('h1', 'do a thing'), assistant('h2', 'the answer')], tail)

    expect(result).toMatchObject({ applied: false, caughtUp: true })
  })

  // The backend's projection is TEXT-ONLY: its snapshot cannot express the
  // reasoning and tool calls the user watched happen.
  it('overlays journal structure onto a live projection row, keeping its id', () => {
    const base = [user('h1', 'do a thing'), assistant('assistant-stream-s1', 'partial', { pending: true })]
    const result = mergeInFlightMessages(base, tail)

    expect(result.applied).toBe(true)
    expect(result.messages[1].id).toBe('assistant-stream-s1')
    expect(result.messages[1].parts.map(p => p.type)).toEqual(['reasoning', 'tool-call'])
  })

  it('matches the prompt on normalized text, not exact whitespace', () => {
    const base = [user('h1', '  do   a thing '), assistant('assistant-stream-s1', '', { pending: true })]

    expect(mergeInFlightMessages(base, tail).applied).toBe(true)
  })

  it('never re-appends a row the base already holds by id', () => {
    const base = [user('u1', 'do a thing'), withTool('assistant-stream-1', { pending: true })]
    const result = mergeInFlightMessages(base, tail)

    expect(result.messages.filter(m => m.id === 'assistant-stream-1')).toHaveLength(1)
  })

  it('does nothing for a tail with no recoverable assistant', () => {
    expect(mergeInFlightMessages([], [user('u1', 'x')])).toMatchObject({ applied: false, caughtUp: false })
  })
})

describe('the persisted journal', () => {
  const busyState = {
    busy: true,
    messages: [user('u1', 'do a thing'), withTool('assistant-stream-1', { pending: true })],
    storedSessionId: 'stored-1',
    turnStartedAt: 1_000
  }

  it('writes on a throttle rather than per repaint', () => {
    vi.useFakeTimers()

    persistInFlightTurnState(busyState)
    persistInFlightTurnState(busyState)

    expect(readInFlightTurnJournal('stored-1')).toBeNull()

    vi.advanceTimersByTime(500)

    expect(readInFlightTurnJournal('stored-1')?.messages.map(m => m.id)).toEqual(['u1', 'assistant-stream-1'])

    vi.useRealTimers()
  })

  it('clears the entry the moment the turn settles', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)

    expect(readInFlightTurnJournal('stored-1')).not.toBeNull()

    persistInFlightTurnState({ ...busyState, busy: false })

    expect(readInFlightTurnJournal('stored-1')).toBeNull()

    vi.useRealTimers()
  })

  // Re-injecting a week-old tail is worse than the gap it fills.
  it('prunes an entry past its age limit', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000)

    expect(readInFlightTurnJournal('stored-1')).toBeNull()

    vi.useRealTimers()
  })

  it('spends the entry once the base transcript has caught up', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()

    const result = recoverInFlightTurnJournal('stored-1', [user('h1', 'do a thing'), assistant('h2', 'the answer')])

    expect(result.caughtUp).toBe(true)
    expect(readInFlightTurnJournal('stored-1')).toBeNull()
  })

  it('restores the turn clock alongside the rows it recovered', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()

    expect(recoverInFlightTurnJournal('stored-1', [])).toMatchObject({ applied: true, turnStartedAt: 1_000 })
  })

  it('is a no-op for a session with no stored id or no entry', () => {
    persistInFlightTurnState({ ...busyState, storedSessionId: null })
    clearInFlightTurnJournal(null)

    expect(recoverInFlightTurnJournal(null, [])).toMatchObject({ applied: false })
    expect(recoverInFlightTurnJournal('nothing-here', [])).toMatchObject({ applied: false })
  })
})
