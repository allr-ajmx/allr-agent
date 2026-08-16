/**
 * MJXHRM-357 — compaction has no `message.start` of its own and produces no
 * output, so without a named hint the transcript just sits there for the length
 * of a summarize call and reads as a hang.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { atom, computed } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => selector({ message: { content: [] } })
}))

vi.mock('@/components/chat/activity-timer-text', () => ({
  ActivityTimerText: ({ seconds }: { seconds: number }) => <span>{seconds}s</span>
}))

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import { $compactingSessions, clearAllCompaction } from '@/store/compaction'
import {
  $activeSessionKey,
  $sessionStates,
  type ClientSessionState,
  emptySessionState,
  publishSessionState
} from '@/store/session-state-types'

import { ResponseLoadingIndicator, StreamStallIndicator } from './status'

const COMPACTING = 'Summarizing thread'

/** A view of ONE session key, in the shape `buildTileView` produces — enough of
 *  the surface for these rows, which read `$runtimeId` / `$busy` / `$messages`. */
function viewOf(key: string): SessionView {
  const state = computed($sessionStates, states => states[key] ?? emptySessionState())

  return {
    kind: 'tile',
    $runtimeId: atom<string | null>(key),
    $storedId: atom<string | null>(null),
    $messages: computed(state, (s: ClientSessionState) => s.messages),
    $busy: computed(state, (s: ClientSessionState) => s.busy),
    $awaitingResponse: atom(false),
    $messagesEmpty: computed(state, (s: ClientSessionState) => s.messages.length === 0),
    $lastVisibleIsUser: atom(false),
    $statusLine: computed(state, (s: ClientSessionState) => s.statusLine),
    $cwd: atom(''),
    $model: atom(''),
    $provider: atom(''),
    $fast: atom(false),
    $reasoningEffort: atom('')
  }
}

const wrap = (node: ReactNode, view?: SessionView) =>
  render(view ? <SessionViewProvider value={view}>{node}</SessionViewProvider> : <>{node}</>)

const seed = (key: string, patch: Partial<ClientSessionState> = {}) =>
  publishSessionState(key, { ...emptySessionState(`stored-${key}`), runtimeSessionId: key, ...patch })

beforeEach(() => {
  $sessionStates.set({})
  clearAllCompaction()
  seed('runtime-1', { busy: true, turnStartedAt: Date.now() })
  $activeSessionKey.set('runtime-1')
})

afterEach(cleanup)

describe('ResponseLoadingIndicator', () => {
  it('names the wait while the session is compacting', () => {
    wrap(<ResponseLoadingIndicator />)
    expect(screen.queryByText(COMPACTING)).toBeNull()

    cleanup()
    $compactingSessions.set({ 'runtime-1': Date.now() })
    wrap(<ResponseLoadingIndicator />)

    expect(screen.getByText(COMPACTING)).toBeTruthy()
  })

  // A manual `/compress` summarizes an IDLE session: no turn, so no `busy`. It
  // is the trigger the ticket names, and gating the row on `busy` alone showed
  // nothing at all for it.
  it('shows the hint for a compaction with no turn behind it', () => {
    seed('runtime-1', { busy: false })
    $compactingSessions.set({ 'runtime-1': Date.now() })
    wrap(<ResponseLoadingIndicator />)

    expect(screen.getByText(COMPACTING)).toBeTruthy()
  })

  // The row reads the SURFACE's session, not the foreground one. Mounted under a
  // tile's view it must answer for the tile — both ways round.
  describe('under a tile view', () => {
    beforeEach(() => {
      seed('runtime-2')
    })

    it('shows the tile session compacting even though the active one is not', () => {
      $compactingSessions.set({ 'runtime-2': Date.now() })
      seed('runtime-2', { busy: true })
      wrap(<ResponseLoadingIndicator />, viewOf('runtime-2'))

      expect(screen.getByText(COMPACTING)).toBeTruthy()
    })

    it('ignores the main pane compacting', () => {
      $compactingSessions.set({ 'runtime-1': Date.now() })
      seed('runtime-2', { busy: true })
      wrap(<ResponseLoadingIndicator />, viewOf('runtime-2'))

      expect(screen.queryByText(COMPACTING)).toBeNull()
    })

    // `$busy` / `$messages` used to be read straight from `store/chat`, i.e. the
    // ACTIVE session — so an idle tile pulsed a spinner and ran a clock whenever
    // the main pane was busy.
    it('stays silent while only the main pane is working', () => {
      wrap(<ResponseLoadingIndicator />, viewOf('runtime-2'))

      expect(screen.queryByRole('status')).toBeNull()
    })
  })

  // The row is mounted for the life of the transcript (the thread list renders it
  // unconditionally; it self-hides), so an anonymous timer reports the age of the
  // THREAD. It has to count from the moment the wait began.
  it('counts from when the compaction started, not from mount', () => {
    seed('runtime-1', { busy: false })
    $compactingSessions.set({ 'runtime-1': Date.now() - 90_000 })
    wrap(<ResponseLoadingIndicator />)

    expect(screen.getByText('90s')).toBeTruthy()
  })

  it('counts a plain wait from the turn start', () => {
    seed('runtime-1', { busy: true, turnStartedAt: Date.now() - 12_000 })
    wrap(<ResponseLoadingIndicator />)

    expect(screen.getByText('12s')).toBeTruthy()
  })
})

describe('StreamStallIndicator', () => {
  // A compaction that starts mid-answer is the worst case for the 2s stall
  // heuristic: the pre-first-token indicator is already gone and a summarize call
  // runs far longer than the window.
  it('shows immediately while compacting, without waiting out the stall window', () => {
    wrap(<StreamStallIndicator />)
    expect(screen.queryByText(COMPACTING)).toBeNull()

    cleanup()
    $compactingSessions.set({ 'runtime-1': Date.now() - 30_000 })
    wrap(<StreamStallIndicator />)

    expect(screen.getByText(COMPACTING)).toBeTruthy()
    // And counts the compaction, not the age of the message it interrupted.
    expect(screen.getByText('30s')).toBeTruthy()
  })

  it('answers for the tile it is mounted in, not the active chat', () => {
    seed('runtime-2')
    $compactingSessions.set({ 'runtime-1': Date.now() })
    wrap(<StreamStallIndicator />, viewOf('runtime-2'))

    expect(screen.queryByText(COMPACTING)).toBeNull()
  })
})
