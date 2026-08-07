import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitWorktree } from '@/global'
import { $dismissedWorktreeIds, $sidebarWorkspaceNodeOpen } from '@/store/layout'
import type * as ProjectsModule from '@/store/projects'
import { removeWorktreePath } from '@/store/projects'
import type { SessionInfo } from '@/types/hermes'

vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsModule>()),
  removeWorktreePath: vi.fn(async () => {})
}))

import { EnteredProjectContent } from './entered-content'
import type { SidebarProjectTree } from './model'

const session = (id: string, cwd: string): SessionInfo => ({
  archived: false,
  cwd,
  ended_at: null,
  id,
  input_tokens: 0,
  is_active: false,
  last_active: 1_000,
  message_count: 1,
  model: 'claude',
  output_tokens: 0,
  preview: null,
  source: 'cli',
  started_at: 1_000,
  title: null,
  tool_call_count: 0
})

const worktree = (over: Partial<HermesGitWorktree> & Pick<HermesGitWorktree, 'path'>): HermesGitWorktree => ({
  branch: null,
  detached: false,
  isMain: false,
  locked: false,
  ...over
})

const project = (): SidebarProjectTree => ({
  id: 'p1',
  label: 'repo',
  path: '/work/repo',
  repos: [
    {
      groups: [
        {
          id: '/work/repo::branch::main',
          isMain: true,
          label: 'main',
          path: '/work/repo',
          sessions: [session('s1', '/work/repo')]
        }
      ],
      id: '/work/repo',
      label: 'repo',
      path: '/work/repo',
      sessionCount: 1
    }
  ],
  sessionCount: 1
})

const worktrees = { '/work/repo': [worktree({ branch: 'main', isMain: true, path: '/work/repo' })] }

const renderRows = (sessions: SessionInfo[]) => sessions.map(row => <div key={row.id}>{row.id}</div>)

const renderContent = (repoWorktrees: Record<string, HermesGitWorktree[]>) =>
  render(<EnteredProjectContent project={project()} renderRows={renderRows} repoWorktrees={repoWorktrees} />)

beforeEach(() => {
  $dismissedWorktreeIds.set([])
  $sidebarWorkspaceNodeOpen.set({})
  vi.mocked(removeWorktreePath).mockClear()
})

afterEach(cleanup)

describe('EnteredProjectContent', () => {
  it('nests a discovered worktree into its own lane', () => {
    renderContent({
      '/work/repo': [
        ...worktrees['/work/repo'],
        worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/feature-x' })
      ]
    })

    // LaneLabel splits the label into head + pinned-tail spans, so match the
    // title attribute (`label\npath`) rather than a single text node.
    expect(screen.getByTitle(/feature\/x/)).toBeInTheDocument()
    // The main lane is labeled by its live branch and holds the session row.
    expect(screen.getByText('s1')).toBeInTheDocument()
  })

  it('hides a dismissed worktree lane that git no longer reports', () => {
    $dismissedWorktreeIds.set(['/work/repo/.worktrees/gone'])

    const { container } = renderContent(worktrees)

    expect(container.textContent).not.toContain('gone')
  })

  it('keeps a dismissed lane visible when git still reports the worktree', () => {
    $dismissedWorktreeIds.set(['/work/repo/.worktrees/feature-x'])

    renderContent({
      '/work/repo': [
        ...worktrees['/work/repo'],
        worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/feature-x' })
      ]
    })

    expect(screen.getByTitle(/feature\/x/)).toBeInTheDocument()
  })

  it('never offers remove on the main lane', async () => {
    renderContent(worktrees)

    // The main lane's header has no kebab (remove is the only kebab action set).
    expect(screen.queryByRole('button', { name: /project actions/i })).toBeNull()
  })

  it('escalates to the force prompt when git refuses a dirty worktree', async () => {
    vi.mocked(removeWorktreePath).mockRejectedValueOnce(new Error('contains modified or untracked files'))

    renderContent({
      '/work/repo': [
        ...worktrees['/work/repo'],
        worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/feature-x' })
      ]
    })

    fireEvent.pointerDown(screen.getByRole('button', { name: /project actions/i }), {
      button: 0,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByText(/remove worktree…/i))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))

    await vi.waitFor(() =>
      expect(removeWorktreePath).toHaveBeenCalledWith('/work/repo', '/work/repo/.worktrees/feature-x', { force: false })
    )
    expect(await screen.findByRole('button', { name: /force remove/i })).toBeInTheDocument()
  })
})
