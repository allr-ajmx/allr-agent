import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setSessionApproval } from '@/store/prompts'
import { onScrollToBottomRequest, resetThreadScroll, setThreadAtBottom } from '@/store/thread-scroll'
import { seedActiveSession } from '@/test-sessions'

import { ScrollToBottomButton } from './scroll-to-bottom-button'
import { type SessionView, SessionViewProvider } from './session-view'

// The bare button reads the PRIMARY session view, whose `$runtimeId` is
// `$activeSessionKey` — so seeding an active session is what gives these renders
// a session key to be scoped by.
const SESSION = 'sess-1'
const OTHER = 'sess-2'

function pendingApproval() {
  seedActiveSession(SESSION)
  setSessionApproval(SESSION, { command: 'rm -rf /tmp/x', description: 'dangerous command', allowPermanent: true })
}

/** A tile's view of another session — what a second open tile renders under.
 *  Only `$runtimeId` is read here; the rest of the surface stays unbuilt. */
const tileView = (key: string): SessionView =>
  ({ kind: 'tile', $runtimeId: atom<null | string>(key) }) as unknown as SessionView

afterEach(() => {
  cleanup()
  setSessionApproval(SESSION, null)
  setSessionApproval(OTHER, null)
  resetThreadScroll(SESSION)
  resetThreadScroll(OTHER)
  resetThreadScroll('')
})

// `getByRole('button')` excludes aria-hidden nodes, so "queryByRole null" is the
// control's hidden (parked-at-bottom) state.
describe('ScrollToBottomButton', () => {
  it('stays hidden while parked at the bottom', () => {
    seedActiveSession(SESSION)
    render(<ScrollToBottomButton />)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is a plain jump-to-bottom control when scrolled up with no approval', () => {
    seedActiveSession(SESSION)
    setThreadAtBottom(SESSION, false)
    render(<ScrollToBottomButton />)

    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()
    expect(screen.queryByText('Approval needed')).toBeNull()
  })

  it('morphs into the approval pill when scrolled up with a pending approval', () => {
    pendingApproval()
    setThreadAtBottom(SESSION, false)
    render(<ScrollToBottomButton />)

    expect(screen.getByRole('button', { name: 'Approval needed' })).toBeTruthy()
    expect(screen.getByText('Approval needed')).toBeTruthy()
  })

  it('does not morph while a pending approval is still in view (at bottom)', () => {
    pendingApproval()
    render(<ScrollToBottomButton />)

    // Parked at bottom → control hidden, so it can't claim "approval needed".
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('re-arms sticky-bottom on click', () => {
    const handler = vi.fn()
    seedActiveSession(SESSION)
    const stop = onScrollToBottomRequest(SESSION, handler)
    setThreadAtBottom(SESSION, false)
    render(<ScrollToBottomButton />)

    fireEvent.click(screen.getByRole('button'))

    expect(handler).toHaveBeenCalledTimes(1)
    stop()
  })

  // MJXHRM-381. One button renders per mounted ChatScreen, i.e. per open tile.
  // On the old global atoms every one of them appeared because ONE thread was
  // scrolled up, every one of them claimed "Approval needed" because the ACTIVE
  // session had a pending approval, and clicking any of them pinned every
  // mounted transcript.
  it('ignores another session scrolling up', () => {
    seedActiveSession(SESSION)
    setThreadAtBottom(OTHER, false)
    render(<ScrollToBottomButton />)

    expect(screen.queryByRole('button')).toBeNull()
  })

  // Deliberately a TILE render. On the primary view the old global `$approval` is
  // a computed over `$activeSessionKey`, so it already answers null for another
  // session — a primary-view version of this test passes either way and proves
  // nothing. A tile is where the two readings diverge.
  it("a tile's button does not borrow the ACTIVE session's approval", () => {
    seedActiveSession(SESSION)
    setSessionApproval(SESSION, { command: 'rm -rf /tmp/x', description: 'dangerous command', allowPermanent: true })
    setThreadAtBottom(OTHER, false)
    render(
      <SessionViewProvider value={tileView(OTHER)}>
        <ScrollToBottomButton />
      </SessionViewProvider>
    )

    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy()
    expect(screen.queryByText('Approval needed')).toBeNull()
  })

  it("a tile's button does morph for its OWN session's approval", () => {
    seedActiveSession(SESSION)
    setSessionApproval(OTHER, { command: 'rm -rf /tmp/x', description: 'dangerous command', allowPermanent: true })
    setThreadAtBottom(OTHER, false)
    render(
      <SessionViewProvider value={tileView(OTHER)}>
        <ScrollToBottomButton />
      </SessionViewProvider>
    )

    expect(screen.getByRole('button', { name: 'Approval needed' })).toBeTruthy()
  })

  it('pins only its own transcript on click', () => {
    const mine = vi.fn()
    const theirs = vi.fn()
    seedActiveSession(SESSION)
    const stopMine = onScrollToBottomRequest(SESSION, mine)
    const stopTheirs = onScrollToBottomRequest(OTHER, theirs)
    setThreadAtBottom(SESSION, false)
    render(<ScrollToBottomButton />)

    fireEvent.click(screen.getByRole('button'))

    expect(mine).toHaveBeenCalledTimes(1)
    expect(theirs).not.toHaveBeenCalled()
    stopMine()
    stopTheirs()
  })

  it("a tile's button follows its own session, not the active one", () => {
    seedActiveSession(SESSION)
    setThreadAtBottom(SESSION, false)
    render(
      <SessionViewProvider value={tileView(OTHER)}>
        <ScrollToBottomButton />
      </SessionViewProvider>
    )

    // The ACTIVE session is scrolled up; this tile's is not.
    expect(screen.queryByRole('button')).toBeNull()
  })
})
