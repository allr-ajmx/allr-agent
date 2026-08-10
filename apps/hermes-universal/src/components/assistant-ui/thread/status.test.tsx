/**
 * MJXHRM-357 — compaction has no `message.start` of its own and produces no
 * output, so without a named hint the transcript just sits there for the length
 * of a summarize call and reads as a hang.
 */

import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => selector({ message: { content: [] } })
}))

// The elapsed timer is a wall-clock ticker; the hint is what's under test.
vi.mock('@/components/chat/activity-timer', () => ({ useElapsedSeconds: () => 3 }))
vi.mock('@/components/chat/activity-timer-text', () => ({
  ActivityTimerText: ({ seconds }: { seconds: number }) => <span>{seconds}s</span>
}))

import { $compactingSessions, clearAllCompaction } from '@/store/compaction'
import { $activeSessionKey, $sessionStates, emptySessionState, publishSessionState } from '@/store/session-state-types'

import { ResponseLoadingIndicator, StreamStallIndicator } from './status'

const COMPACTING = 'Summarizing thread'

const wrap = (node: ReactNode) => render(<>{node}</>)

beforeEach(() => {
  $sessionStates.set({})
  clearAllCompaction()
  publishSessionState('runtime-1', { ...emptySessionState('stored-1'), runtimeSessionId: 'runtime-1', busy: true })
  $activeSessionKey.set('runtime-1')
})

afterEach(cleanup)

describe('ResponseLoadingIndicator', () => {
  it('names the wait while the session is compacting', () => {
    wrap(<ResponseLoadingIndicator />)
    expect(screen.queryByText(COMPACTING)).toBeNull()

    cleanup()
    $compactingSessions.set({ 'runtime-1': true })
    wrap(<ResponseLoadingIndicator />)

    expect(screen.getByText(COMPACTING)).toBeTruthy()
  })

  // A tile must never show the main pane's compaction. The hint is read through
  // the surface's own session view, and the default view is the active session.
  it('ignores a different session, so a tile never shows the main pane compacting', () => {
    $compactingSessions.set({ 'runtime-2': true })
    wrap(<ResponseLoadingIndicator />)

    expect(screen.queryByText(COMPACTING)).toBeNull()
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
    $compactingSessions.set({ 'runtime-1': true })
    wrap(<StreamStallIndicator />)

    expect(screen.getByText(COMPACTING)).toBeTruthy()
  })
})
