import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { $pinnedSessionIds, $sidebarAgentsGrouped } from '@/store/layout'
import { $showAllProfiles } from '@/store/profile'
import { $profiles } from '@/store/profiles'
import { $projectScope, $projectTree, ALL_PROJECTS } from '@/store/projects'
// NOTE: import `@/store/session` (→ @/hermes → connection) before `@/store/projects`
// (→ @/store/gateway). Entering the gateway↔connection import cycle via the
// gateway side first leaves connection.ts's top-level `$gatewayState.subscribe`
// reading a TDZ value. The running app always loads connection first (you connect
// before the sidebar mounts), so this ordering only matters under cold test eval.
import { $sessions } from '@/store/session'
import type { ProfileInfo, SessionInfo } from '@/types/hermes'

import type { SidebarProjectTree } from './projects/model'
import { SidebarScrollBody } from './sidebar-content'

function makeProfile(name: string, isDefault = false): ProfileInfo {
  return {
    name,
    path: `/p/${name}`,
    is_default: isDefault,
    has_env: false,
    model: null,
    provider: null,
    skill_count: 0
  }
}

function makeSession(id: string, title: string, startedAt: number, profile?: string): SessionInfo {
  return {
    profile,
    _lineage_root_id: null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: startedAt,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: startedAt,
    title,
    tool_call_count: 0
  }
}

function makeProject(id: string, label: string): SidebarProjectTree {
  return { id, isAuto: false, label, path: null, previewSessions: [], repos: [], sessionCount: 2 }
}

afterEach(() => {
  $sessions.set([])
  $pinnedSessionIds.set([])
  $sidebarAgentsGrouped.set(false)
  $projectTree.set([])
  $projectScope.set(ALL_PROJECTS)
  $profiles.set([])
  $showAllProfiles.set(false)
})

describe('SidebarScrollBody — pinned vs recents split', () => {
  it('shows a pinned session under Pinned and the rest under Sessions', () => {
    $sessions.set([makeSession('a', 'Alpha chat', 200), makeSession('b', 'Beta chat', 100)])
    $pinnedSessionIds.set(['a'])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    // Both section labels present, and both rows render.
    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    expect(screen.getByText('Alpha chat')).toBeInTheDocument()
    expect(screen.getByText('Beta chat')).toBeInTheDocument()
  })

  it('shows the pin hint when nothing is pinned', () => {
    $sessions.set([makeSession('b', 'Beta chat', 100)])
    $pinnedSessionIds.set([])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    expect(screen.getByText('Shift-click a chat to pin')).toBeInTheDocument()
  })

  it('renders the projects overview in grouped mode', () => {
    $sidebarAgentsGrouped.set(true)
    $projectScope.set(ALL_PROJECTS)
    $projectTree.set([makeProject('p_1', 'Skunkworks'), makeProject('p_2', 'Website')])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('Skunkworks')).toBeInTheDocument()
    expect(screen.getByText('Website')).toBeInTheDocument()
  })
})

describe('SidebarScrollBody — all-profiles browse scope', () => {
  const enterBrowseScope = () => {
    $profiles.set([makeProfile('default', true), makeProfile('research')])
    $showAllProfiles.set(true)
    $sessions.set([
      makeSession('a', 'Alpha chat', 200, 'default'),
      makeSession('b', 'Beta chat', 100, 'research'),
      makeSession('c', 'Gamma chat', 50, 'research')
    ])
  }

  const renderBody = () =>
    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

  it('renders one lane per profile, default first, with owning-profile chips', () => {
    enterBrowseScope()
    renderBody()

    // Lane headers (the profile keys), default before the named one.
    const lanes = screen.getAllByRole('button', { name: /^(default|research)$/ }).map(node => node.textContent)
    expect(lanes).toEqual(['default', 'research'])

    expect(screen.getByLabelText('Owned by default')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Owned by research')).toHaveLength(2)
  })

  it('drops the lanes and the chips back in a concrete scope', () => {
    enterBrowseScope()
    $showAllProfiles.set(false)
    renderBody()

    expect(screen.queryByLabelText('Owned by research')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'research' })).not.toBeInTheDocument()
    expect(screen.getByText('Alpha chat')).toBeInTheDocument()
  })

  it('keeps the browse view single-profile-safe (no lanes with one profile)', () => {
    enterBrowseScope()
    $profiles.set([makeProfile('default', true)])
    renderBody()

    expect(screen.queryByRole('button', { name: 'research' })).not.toBeInTheDocument()
    expect(screen.getByText('Beta chat')).toBeInTheDocument()
  })
})
