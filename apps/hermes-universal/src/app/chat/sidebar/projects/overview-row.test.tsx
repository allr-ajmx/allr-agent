import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $removedSessionIds } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import type { SidebarProjectTree } from './model'
import { ProjectOverviewRow } from './overview-row'

// MJXHRM-414's second half. The project tree is a BACKEND SNAPSHOT — it only
// changes when `projects.tree` is re-fetched — so a session deleted a moment ago
// is still in it, and this preview list was the one sidebar surface that never
// applied the tombstone overlay. A deleted chat kept appearing under its
// project, and could be clicked.

const session = (id: string): SessionInfo =>
  ({ id, last_active: 1_000, message_count: 1, source: 'cli', started_at: 1_000, title: id }) as SessionInfo

const project = (sessions: SessionInfo[]): SidebarProjectTree =>
  ({
    id: 'p1',
    label: 'repo',
    path: '/work/repo',
    repos: [
      {
        groups: [{ id: '/work/repo::branch::main', isMain: true, label: 'main', path: '/work/repo', sessions }],
        id: '/work/repo',
        label: 'repo',
        path: '/work/repo',
        sessionCount: sessions.length
      }
    ],
    sessionCount: sessions.length
  }) as SidebarProjectTree

const renderRows = (sessions: SessionInfo[]) => sessions.map(row => <div key={row.id}>{row.id}</div>)

const renderRow = (sessions: SessionInfo[]) =>
  render(<ProjectOverviewRow project={project(sessions)} renderRows={renderRows} />)

/** The previews are behind a hover-revealed caret; open it. */
const expandPreviews = () => fireEvent.click(screen.getByRole('button', { name: '' }))

beforeEach(() => $removedSessionIds.set(new Set()))
afterEach(() => {
  cleanup()
  $removedSessionIds.set(new Set())
})

describe('ProjectOverviewRow previews', () => {
  it('lists the project’s sessions when nothing has been removed', () => {
    renderRow([session('s1'), session('s2')])
    expandPreviews()

    expect(screen.getByText('s1')).toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
  })

  it('never previews a session the user just deleted', () => {
    $removedSessionIds.set(new Set(['s1']))

    renderRow([session('s1'), session('s2')])
    expandPreviews()

    expect(screen.queryByText('s1')).not.toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
  })

  // The subscription, not just the filter: the tree does not change when a
  // session is deleted, so without a reason to re-render this row would keep
  // showing the deleted chat until something ELSE moved.
  it('drops a preview the moment the tombstone lands, with no new tree', () => {
    renderRow([session('s1'), session('s2')])
    expandPreviews()
    expect(screen.getByText('s1')).toBeInTheDocument()

    act(() => $removedSessionIds.set(new Set(['s1'])))

    expect(screen.queryByText('s1')).not.toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
  })

  // A pin is stored on the durable lineage root while the tree lists the live
  // tip, so a delete that tombstoned the root has to reach this row too.
  it('drops a preview tombstoned under its lineage root', () => {
    const tip = { ...session('tip'), _lineage_root_id: 'root' } as SessionInfo
    $removedSessionIds.set(new Set(['root']))

    renderRow([tip, session('s2')])
    expandPreviews()

    expect(screen.queryByText('tip')).not.toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
  })
})
