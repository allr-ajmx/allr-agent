/**
 * MJXHRM-386 — a session TILE's tab, the ticket's headline surface.
 *
 * `sessionRowFor` has its own tests, but nothing exercised the tab that reads
 * through it: a tile can outlive the recents page it was opened from, and its
 * title used to fall back to the bare, untranslated literal `'Session'`. The
 * mirror is the interesting half — the tab is registered from a plain string
 * captured at sync time, so widening the lookup only reaches the tab if the
 * mirror ALSO re-syncs when a later source lands.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import { findTile } from '@/components/pane-shell/tile/registry'
import { $projectTree } from '@/store/projects'
import { $sessions } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { watchSessionTiles } from './session-tile'

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

const tabTitle = (storedSessionId: string): string | undefined => findTile(`session-tile:${storedSessionId}`)?.title

// Once, not per test: the mirror holds module-level state in its closure, and
// each call adds another subscription to the same source atoms.
watchSessionTiles()

afterEach(() => {
  $sessionTiles.set([])
  $sessions.set([])
  $projectTree.set([])
})

describe('session tile tab title', () => {
  it('names a tile whose session the recents page has scrolled past', () => {
    $sessions.set([row('someone-else', 'A newer chat')])
    $projectTree.set([treeWith([row('old-1', 'Ship the parser')])])
    $sessionTiles.set([{ storedSessionId: 'old-1' }] as never)

    expect(tabTitle('old-1')).toBe('Ship the parser')
  })

  it('resolves a tile holding a pre-compaction id', () => {
    // The tile keeps the id it was opened with; the row that answers to it is
    // the rotated tip, matched by lineage.
    $sessions.set([row('tip-9', 'Compacted but named', 'root-9')])
    $sessionTiles.set([{ storedSessionId: 'root-9' }] as never)

    expect(tabTitle('root-9')).toBe('Compacted but named')
  })

  it('retitles when a fallback source lands after the tile was registered', () => {
    // The mirror's `also` list is the load-bearing half: it must carry every
    // source the lookup reads, or a better title arrives one page-load late and
    // the tab sits on its placeholder until something unrelated re-renders.
    $sessionTiles.set([{ storedSessionId: 'late-1' }] as never)
    expect(tabTitle('late-1')).toBe('Loading…')

    $projectTree.set([treeWith([row('late-1', 'Arrived with the tree')])])

    expect(tabTitle('late-1')).toBe('Arrived with the tree')
  })
})
