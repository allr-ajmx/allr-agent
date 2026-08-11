import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import {
  __resetInFlightTurnJournalCache,
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
  __resetInFlightTurnJournalCache()
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

  // A journaled row was captured mid-stream, so it carries `pending: true`. If
  // the turn died with the app, nothing will ever complete it — leaving the
  // flag on renders a bubble that spins forever beside an idle composer.
  it('seals a recovered row when the turn is not still running', () => {
    const result = mergeInFlightMessages([], tail)

    expect(result.messages.at(-1)?.pending).toBe(false)
  })

  it('keeps it pending when the backend says the turn survived', () => {
    const result = mergeInFlightMessages([], tail, { keepPending: true })

    expect(result.messages.at(-1)?.pending).toBe(true)
  })

  // `appendLiveSessionProjection` seeds an EMPTY assistant boundary row before
  // the first delta of a queued turn. Counting it as the committed reply threw
  // the journal away and left the crashed turn as a blank bubble.
  it('does not treat an empty assistant row as the settled reply', () => {
    const base = [user('h1', 'do a thing'), assistant('h2', '')]

    expect(mergeInFlightMessages(base, tail)).toMatchObject({ applied: true, caughtUp: false })
  })

  // The snapshot's text can be up to one throttle window newer than the
  // journal's; taking the journal's parts wholesale rolled the answer back.
  it('keeps the projection text when it extends what the journal recorded', () => {
    const journaled = [user('u1', 'do a thing'), assistant('assistant-stream-1', 'the ans', { pending: true })]
    const base = [user('u1', 'do a thing'), assistant('assistant-stream-s1', 'the answer', { pending: true })]
    const result = mergeInFlightMessages(base, journaled)

    expect(result.messages[1].id).toBe('assistant-stream-s1')
    expect(chatMessageText(result.messages[1])).toBe('the answer')
  })
})

describe('the persisted journal', () => {
  const busyState = {
    awaitingResponse: false,
    busy: true,
    messages: [user('u1', 'do a thing'), withTool('assistant-stream-1', { pending: true })],
    storedSessionId: 'stored-1',
    streamId: 'assistant-stream-1',
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

    persistInFlightTurnState({ ...busyState, busy: false, streamId: null })

    expect(readInFlightTurnJournal('stored-1')).toBeNull()

    vi.useRealTimers()
  })

  // `busy` alone is not "the turn is over". A submit that has left but not been
  // acknowledged, and a stream still bound to a row, are both live turns — and
  // both are windows a crash is likely to land in.
  it('keeps the entry while the turn is only unacknowledged or still bound', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)

    persistInFlightTurnState({ ...busyState, busy: false, streamId: null, awaitingResponse: true })
    expect(readInFlightTurnJournal('stored-1')).not.toBeNull()

    persistInFlightTurnState({ ...busyState, busy: false })
    expect(readInFlightTurnJournal('stored-1')).not.toBeNull()

    vi.useRealTimers()
  })

  // The rows a recovery appends are LOCAL-ONLY: the backend never persisted
  // them, so a later cold open cannot satisfy `caughtUp` and would replay the
  // same dead turn on every open for the whole seven-day TTL.
  it('spends an entry it successfully folded into a settled transcript', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()

    expect(recoverInFlightTurnJournal('stored-1', []).applied).toBe(true)
    expect(readInFlightTurnJournal('stored-1')).toBeNull()
  })

  // A running turn still owns its entry — the fold is not the end of it.
  it('keeps the entry when the backend says the turn is still running', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()

    expect(recoverInFlightTurnJournal('stored-1', [], { keepPending: true }).applied).toBe(true)
    expect(readInFlightTurnJournal('stored-1')).not.toBeNull()
  })

  // The clear path runs for every idle session on every state commit, i.e. on
  // every token of every other session's turn. Answering it from storage meant
  // a synchronous getItem + JSON.parse per idle session per delta.
  it('answers a clear for an unjournaled session without touching storage', () => {
    // jsdom's Storage is a Proxy that swallows an own-property spy, so the
    // counter has to sit on the prototype the instance actually resolves
    // through (the Node-26 shim in test-setup is a plain object, hence both).
    const readTarget = (
      typeof Storage !== 'undefined' && window.localStorage instanceof Storage ? Storage.prototype : window.localStorage
    ) as Storage

    const getItem = vi.spyOn(readTarget, 'getItem')
    const removeItem = vi.spyOn(readTarget, 'removeItem')

    clearInFlightTurnJournal('never-journaled')
    clearInFlightTurnJournal('never-journaled')
    clearInFlightTurnJournal('never-journaled')

    // One read only, and it is the once-per-renderer v1 probe — not a per-call
    // parse of the store. The key mirror answers the rest, so nothing reaches
    // storage for a session that was never journaled.
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(removeItem).not.toHaveBeenCalled()
    getItem.mockRestore()
    removeItem.mockRestore()
  })

  // The v1 store kept every session under ONE key, so each throttled write
  // re-parsed and re-stringified every OTHER busy session's tail — a grid of
  // streaming tiles turned the journal into a whole-store JSON round trip
  // several times a second, on the token path (upstream 3139a30e52).
  it('writes each session under its own key, untouched by another settling', () => {
    vi.useFakeTimers()
    persistInFlightTurnState(busyState)
    persistInFlightTurnState({ ...busyState, storedSessionId: 'stored-2' })
    vi.advanceTimersByTime(500)
    vi.useRealTimers()

    const keys = Object.keys(window.localStorage).filter(key => key.includes('inflightTurnJournal'))

    expect(keys).toHaveLength(2)

    // A spy that would catch a regression to the shared blob: clearing one
    // session must not rewrite the other's storage entry at all.
    const raw = window.localStorage.getItem(keys.find(key => key.endsWith('stored-1')) as string)

    clearInFlightTurnJournal('stored-2')

    expect(window.localStorage.getItem(keys.find(key => key.endsWith('stored-1')) as string)).toBe(raw)
    expect(readInFlightTurnJournal('stored-1')).not.toBeNull()
    expect(readInFlightTurnJournal('stored-2')).toBeNull()
  })

  it('recovers turns journaled by the single-key v1 store', () => {
    // A crash that happened before the upgrade is exactly the crash the journal
    // exists for; dropping v1 on migration would lose it.
    window.localStorage.setItem(
      'hermes.universal.inflightTurnJournal.v1',
      JSON.stringify({
        entries: {
          'stored-legacy': {
            messages: [user('u1', 'legacy prompt'), assistant('a1', 'legacy partial', { pending: true })],
            streamId: 'a1',
            turnStartedAt: 500,
            updatedAt: Date.now()
          }
        },
        version: 1
      })
    )
    __resetInFlightTurnJournalCache()

    const snapshot = readInFlightTurnJournal('stored-legacy')

    expect(snapshot?.streamId).toBe('a1')
    expect(snapshot?.messages).toHaveLength(2)
    // …and the v1 blob is gone, so it cannot be migrated twice.
    expect(window.localStorage.getItem('hermes.universal.inflightTurnJournal.v1')).toBeNull()
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
