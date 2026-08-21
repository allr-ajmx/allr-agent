/**
 * MJXHRM-385 / MJXHRM-386 — the mobile bubble strip resolves its rows through
 * the WIDE session lookup, like every other surface that renders a session.
 *
 * `$sessions` is the paginated recents page, not the set of sessions that
 * exist. The strip used to `find` in it directly, so a bubble for an older chat
 * — restored from the persisted strip on a cold start, say — got no row at all:
 * its label stayed on "Loading…" forever, and once MJXHRM-385 put the shared
 * status dot on the badge, its idle dot lost the project colour too (the colour
 * resolver takes a `SessionInfo` and there was none to give it).
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ChatBubblesModule from '@/store/chat-bubbles'
import type { SessionInfo } from '@/types/hermes'

vi.mock('@/lib/touch', () => ({ triggerHaptic: () => {} }))

// Only the switch verb is stubbed. `switchToBubble` promotes through
// `openSession`, which wants a gateway; everything else in the store (the row
// atom, the close verb the drag-up test drives) stays real.
const switchSpy = vi.fn()

vi.mock('@/store/chat-bubbles', async importOriginal => ({
  ...(await importOriginal<typeof ChatBubblesModule>()),
  switchToBubble: switchSpy
}))

const { $projectTree } = await import('@/store/projects')
const { $sessions, $activeStoredSessionId } = await import('@/store/session')
const { $chatBubbles } = await import('@/store/chat-bubbles')
const { stashSessionDraft } = await import('@/store/composer')
const { $activeSessionKey } = await import('@/store/session-state-types')
const { BubbleRow } = await import('./bubble-row')

const row = (id: string, title: string): SessionInfo => ({ id, title }) as unknown as SessionInfo

beforeEach(() => {
  $sessions.set([])
  $projectTree.set([])
  $activeStoredSessionId.set(null)
  $chatBubbles.set([])
  stashSessionDraft($activeSessionKey.get(), '', [])
  switchSpy.mockClear()
})

describe('BubbleRow session rows', () => {
  it('names a bubble whose session is outside the loaded recents page', () => {
    // Only ONE of the two chats is on the recents page; the other lives in the
    // project tree, which is exactly the fallback the wider lookup exists for.
    $sessions.set([row('recent-1', 'On the page')])
    $projectTree.set([
      {
        id: 'p1',
        name: 'Project',
        previewSessions: [row('older-2', 'Older chat')],
        repos: []
      }
    ] as never)
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])

    render(<BubbleRow />)

    // Not "Loading…": the strip found the row through the project tree.
    expect(screen.getByLabelText('Older chat')).toBeTruthy()
    expect(screen.getByLabelText('On the page')).toBeTruthy()
  })

  it('subscribes to the fallback sources, so a late-arriving tree retitles', () => {
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])
    $sessions.set([row('recent-1', 'On the page')])

    const { rerender } = render(<BubbleRow />)

    $projectTree.set([
      { id: 'p1', name: 'Project', previewSessions: [row('older-2', 'Arrived late')], repos: [] }
    ] as never)
    rerender(<BubbleRow />)

    expect(screen.getByLabelText('Arrived late')).toBeTruthy()
  })
})

/**
 * The strip is this phone's tab bar, and a draft is a tab. Its bubble is one of
 * two identical dots with nothing to tell them apart, so the peek label saying
 * "New session" for the chat you have half-written into is the same gap the
 * workspace tab had while the draft TILE named itself (MJXHRM-396).
 */
describe('BubbleRow draft naming', () => {
  it('names the unsaved chat after what is typed into it', () => {
    $chatBubbles.set([{ storedSessionId: null }, { storedSessionId: 'recent-1' }])
    $sessions.set([row('recent-1', 'On the page')])
    // The composer stashes under the LIVE session key, which for an unsaved chat
    // is the draft slice `bubbleRuntimeKey(null)` resolves to.
    stashSessionDraft($activeSessionKey.get(), 'fix the login redirect', [])

    render(<BubbleRow />)

    expect(screen.getByLabelText('fix the login redirect')).toBeTruthy()
  })

  it('keeps the placeholder while the draft is empty', () => {
    $chatBubbles.set([{ storedSessionId: null }, { storedSessionId: 'recent-1' }])
    $sessions.set([row('recent-1', 'On the page')])

    render(<BubbleRow />)

    expect(screen.getByLabelText('New session')).toBeTruthy()
  })
})

/**
 * The gesture belongs to the ROW, not to the 32px dots inside it. Requiring the
 * press to land on a bubble made the carousel something you had to aim at — a
 * swipe begun in a gap did nothing, and drag-up-to-close was out of reach unless
 * your thumb was already on the centred dot.
 */
describe('BubbleRow gesture surface', () => {
  const track = () => document.querySelector('[data-slot="bubble-track"]') as HTMLElement

  // The strip drives itself off window listeners once the press starts, so a
  // gesture is: press the row, move, let go.
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    fireEvent.pointerDown(track(), { button: 0, clientX: from.x, clientY: from.y })
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y })
    // The move is rAF-coalesced; let the frame land before releasing.
    await act(async () => {
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    })
    fireEvent.pointerUp(window)
  }

  it('starts the gesture from empty track, not just from a bubble', () => {
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])
    $sessions.set([row('recent-1', 'On the page'), row('older-2', 'Older chat')])
    $activeStoredSessionId.set('recent-1')

    render(<BubbleRow />)
    fireEvent.pointerDown(track(), { button: 0, clientX: 10, clientY: 10 })

    // The peek tooltip only exists while a press is live, so its title showing
    // up is the row saying "I took the gesture".
    expect(screen.getAllByText('On the page').length).toBeGreaterThan(0)

    fireEvent.pointerUp(window)
  })

  it('closes the centred chat on a drag up that starts anywhere in the row', async () => {
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])
    $sessions.set([row('recent-1', 'On the page'), row('older-2', 'Older chat')])
    $activeStoredSessionId.set('older-2')

    render(<BubbleRow />)
    // Well past UP_CLOSE_PX, and more vertical than horizontal so it reads as a
    // close rather than a switch.
    await drag({ x: 10, y: 200 }, { x: 14, y: 120 })

    expect($chatBubbles.get().map(b => b.storedSessionId)).toEqual(['recent-1'])
  })

  // The gesture acts on whatever is CENTRED, so before this a press on an
  // off-centre bubble resolved to "switch to the chat you are already in" — the
  // one thing a tab strip has to be able to do, and the only one it could not.
  // jsdom gives every element a zero rect, so x=0 is the only point inside a
  // bubble and anything else is empty track.
  it('switches to the bubble a tap lands on', () => {
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])
    $sessions.set([row('recent-1', 'On the page'), row('older-2', 'Older chat')])
    $activeStoredSessionId.set('older-2')

    render(<BubbleRow />)
    fireEvent.pointerDown(track(), { button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(window)

    expect(switchSpy).toHaveBeenCalledWith('recent-1')
  })

  it('falls back to the centred bubble when the press was not on one', () => {
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])
    $sessions.set([row('recent-1', 'On the page'), row('older-2', 'Older chat')])
    $activeStoredSessionId.set('older-2')

    render(<BubbleRow />)
    // Empty track: no tap target, so the release lands where the drag left the
    // strip — which, without a move, is the chat already on screen.
    fireEvent.pointerDown(track(), { button: 0, clientX: 40, clientY: 0 })
    fireEvent.pointerUp(window)

    expect(switchSpy).toHaveBeenCalledWith('older-2')
  })

  it('leaves the row alone when the same drag goes sideways', async () => {
    $chatBubbles.set([{ storedSessionId: 'recent-1' }, { storedSessionId: 'older-2' }])
    $sessions.set([row('recent-1', 'On the page'), row('older-2', 'Older chat')])
    $activeStoredSessionId.set('older-2')

    render(<BubbleRow />)
    await drag({ x: 200, y: 200 }, { x: 120, y: 190 })

    expect($chatBubbles.get()).toHaveLength(2)
  })
})
