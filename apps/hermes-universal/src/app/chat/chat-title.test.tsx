/**
 * MJXHRM-386 — the chat title bar must name a session it can't find in recents.
 *
 * `ChatTitle` is three surfaces at once: the mobile top bar, the desktop chat
 * header, and the titlebar of a DETACHED session window. It resolved the open
 * session with `$sessions.find(s => s.id === lookupId)` — the paginated recents
 * page, compared by live id alone — and `openSession` never inserts the row it
 * resumed. So an older conversation read "New session", and because the pill is
 * only rendered when a row resolves, its whole session menu (rename / pin /
 * archive / delete) was missing too.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import { $pinnedSessionIds } from '@/store/layout'
import { $projectTree } from '@/store/projects'
import { $activeStoredSessionId, $sessions } from '@/store/session'
import { resetSessionStates, seedActiveSession } from '@/test-sessions'
import type { SessionInfo } from '@/types/hermes'

import { ChatTitle } from './chat-title'

const row = (id: string, title: string, lineageRoot?: string): SessionInfo =>
  ({ id, title, ...(lineageRoot ? { _lineage_root_id: lineageRoot } : {}) }) as unknown as SessionInfo

const treeWith = (sessions: SessionInfo[]): SidebarProjectTree =>
  ({
    id: 'p1',
    label: 'Project',
    path: '/repo',
    previewSessions: [],
    repos: [
      {
        id: 'r1',
        label: 'repo',
        path: '/repo',
        groups: [{ id: 'g1', label: 'main', path: '/repo', sessions }],
        sessionCount: sessions.length
      }
    ],
    sessionCount: sessions.length
  }) as SidebarProjectTree

const renderTitle = () =>
  render(
    <MemoryRouter>
      <ChatTitle />
    </MemoryRouter>
  )

afterEach(() => {
  cleanup()
  resetSessionStates()
  $activeStoredSessionId.set(null)
  $sessions.set([])
  $projectTree.set([])
  $pinnedSessionIds.set([])
})

describe('ChatTitle — identity outside the recents page', () => {
  it('names a session the recents page has scrolled past', () => {
    // The recents page holds something else entirely; the chat on screen is only
    // in the project tree. This is the ticket's headline case.
    seedActiveSession('runtime-1', { storedSessionId: 'old-1' })
    $activeStoredSessionId.set('old-1')
    $sessions.set([row('someone-else', 'A newer chat')])
    $projectTree.set([treeWith([row('old-1', 'Ship the parser')])])

    renderTitle()

    expect(screen.getByText('Ship the parser')).toBeTruthy()
    expect(screen.queryByText('New session')).toBeNull()
  })

  it('keeps the session menu on a chat outside recents', () => {
    // Not cosmetic: with no row there was no pill, so rename / pin / archive /
    // delete were unreachable — and in a detached window this bar is the ONLY
    // place they are reachable from. The pill is a menu trigger; the plain
    // fallback span is not.
    seedActiveSession('runtime-1', { storedSessionId: 'old-1' })
    $activeStoredSessionId.set('old-1')
    $projectTree.set([treeWith([row('old-1', 'Ship the parser')])])

    renderTitle()

    expect(screen.getByText('Ship the parser').closest('[aria-haspopup="menu"]')).toBeTruthy()
  })

  it('resolves an id held from before an auto-compaction', () => {
    // The surfaces keep their pre-rotation stored id on purpose; the row that
    // answers to it is the rotated tip, found by lineage — never by `id ===`.
    seedActiveSession('runtime-1', { storedSessionId: 'root-1' })
    $activeStoredSessionId.set('root-1')
    $sessions.set([row('tip-9', 'Compacted but named', 'root-1')])

    renderTitle()

    expect(screen.getByText('Compacted but named')).toBeTruthy()
  })

  it('says loading, not "New session", for a stored id no source knows yet', () => {
    seedActiveSession('runtime-1', { storedSessionId: 'not-here-yet' })
    $activeStoredSessionId.set('not-here-yet')

    renderTitle()

    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('New session')).toBeNull()
  })

  it('still says "New session" for a chat that has only ever been a runtime id', () => {
    // The one case the string is correct: a fresh chat that has reached the
    // backend but has never been saved to the list. Widening the lookup must
    // not turn this into "Loading…" forever.
    seedActiveSession('runtime-1', { storedSessionId: null })

    renderTitle()

    expect(screen.getByText('New session')).toBeTruthy()
  })
})
