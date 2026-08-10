/**
 * MJXHRM-386 — a tab must not lose a session's identity just because the
 * recents page has scrolled past it.
 *
 * `$sessions` is a paginated window, and every surface that rendered a session
 * by id treated a miss in it as "unknown": a tile tab fell back to the literal
 * `'Session'`, the main tab read `'New session'` over a named chat, and both
 * lost their colour — because the colour resolver needs a `SessionInfo` and
 * there was none to hand it. Widening the lookup is the whole fix; the colour
 * then falls out of `sessionColorFor` unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import type { SessionInfo } from '@/types/hermes'

import { $pinnedSessionIds } from './layout'
import { $projectTree } from './projects'
import { $sessions } from './session'
import { sessionRowFor } from './session-lookup'

const row = (id: string, title: string): SessionInfo => ({ id, title }) as unknown as SessionInfo

const tree = (sessions: SessionInfo[], previews: SessionInfo[] = []): SidebarProjectTree =>
  ({
    id: 'p1',
    label: 'Project',
    path: '/repo',
    repos: [
      {
        id: 'r1',
        label: 'repo',
        path: '/repo',
        groups: [{ id: 'g1', label: 'main', path: '/repo', sessions }],
        sessionCount: sessions.length
      }
    ],
    sessionCount: sessions.length,
    previewSessions: previews
  }) as SidebarProjectTree

afterEach(() => {
  $sessions.set([])
  $projectTree.set([])
  $pinnedSessionIds.set([])
})

describe('sessionRowFor', () => {
  it('prefers the loaded recents row', () => {
    $sessions.set([row('a', 'Loaded')])
    $projectTree.set([tree([row('a', 'Stale tree copy')])])

    expect(sessionRowFor('a')?.title).toBe('Loaded')
  })

  it('falls back to the pinned cache once the row leaves the recents page', () => {
    // The cache is populated by pinning a session that IS loaded...
    $pinnedSessionIds.set(['a'])
    $sessions.set([row('a', 'Pinned chat')])

    // ...and survives the page moving on, which is the case that used to render
    // as the bare string 'Session'.
    $sessions.set([row('z', 'Something else')])

    expect(sessionRowFor('a')?.title).toBe('Pinned chat')
  })

  it('falls back to the project tree, including a project overview preview', () => {
    $projectTree.set([tree([row('deep', 'Deep in a lane')], [row('preview', 'Overview preview')])])

    expect(sessionRowFor('deep')?.title).toBe('Deep in a lane')
    expect(sessionRowFor('preview')?.title).toBe('Overview preview')
  })

  it('is null for a genuinely unknown id, and for no id at all', () => {
    $sessions.set([row('a', 'A')])

    expect(sessionRowFor('nope')).toBeNull()
    expect(sessionRowFor(null)).toBeNull()
    expect(sessionRowFor('')).toBeNull()
  })
})
