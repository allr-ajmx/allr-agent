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

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

vi.mock('@/lib/touch', () => ({ triggerHaptic: () => {} }))

const { $projectTree } = await import('@/store/projects')
const { $sessions, $activeStoredSessionId } = await import('@/store/session')
const { $chatBubbles } = await import('@/store/chat-bubbles')
const { BubbleRow } = await import('./bubble-row')

const row = (id: string, title: string): SessionInfo => ({ id, title }) as unknown as SessionInfo

beforeEach(() => {
  $sessions.set([])
  $projectTree.set([])
  $activeStoredSessionId.set(null)
  $chatBubbles.set([])
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
