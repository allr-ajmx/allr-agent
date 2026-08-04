import { describe, expect, it } from 'vitest'

import type { HermesGitWorktree } from '@/global'
import type { SessionInfo } from '@/types/hermes'

import type { SidebarSessionGroup } from './model'
import { baseName, kanbanWorktreeDir, mergeRepoWorktreeGroups, sortWorktreeGroups } from './workspace-groups'

// The grouping itself lives on the backend (tui_gateway/project_tree.py). This
// covers only the thin render helpers + the VISUAL worktree enhancer, ported
// from desktop's suite of the same name.

let nextId = 0

function makeSession(cwd: null | string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    archived: false,
    cwd,
    ended_at: null,
    id: `s${nextId++}`,
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
    tool_call_count: 0,
    ...overrides
  }
}

const lane = (over: Partial<SidebarSessionGroup> & Pick<SidebarSessionGroup, 'id' | 'label'>): SidebarSessionGroup => ({
  path: null,
  sessions: [],
  ...over
})

const worktree = (over: Partial<HermesGitWorktree> & Pick<HermesGitWorktree, 'path'>): HermesGitWorktree => ({
  branch: null,
  detached: false,
  isMain: false,
  locked: false,
  ...over
})

const labels = (groups: SidebarSessionGroup[]) => groups.map(group => group.label)

describe('baseName', () => {
  it('returns the final path segment, ignoring trailing slashes and separators', () => {
    expect(baseName('/work/repo')).toBe('repo')
    expect(baseName('/work/repo/')).toBe('repo')
    expect(baseName('C:\\work\\repo')).toBe('repo')
  })
})

describe('kanbanWorktreeDir', () => {
  it('matches the ephemeral t_<hex> task worktrees kanban_db mints', () => {
    expect(kanbanWorktreeDir('/work/repo/.worktrees/t_a1b2c3')).toBe('/work/repo/.worktrees')
    expect(kanbanWorktreeDir('/work/repo/.worktrees/t_a1b2c3/')).toBe('/work/repo/.worktrees')
  })

  it('leaves user-named worktrees alone so they keep their own lane', () => {
    expect(kanbanWorktreeDir('/work/repo/.worktrees/my-feature')).toBeNull()
    expect(kanbanWorktreeDir('/work/repo')).toBeNull()
  })
})

describe('sortWorktreeGroups', () => {
  it('pins home above trunk even with no sessions, and sinks the kanban bucket', () => {
    const sorted = sortWorktreeGroups([
      lane({ id: 'k', isKanban: true, label: 'kanban', sessions: [makeSession('/work/repo', { last_active: 9_000 })] }),
      lane({ id: 'feat', label: 'feature/x', sessions: [makeSession('/work/repo', { last_active: 8_000 })] }),
      lane({ id: 'trunk', isMain: true, label: 'main', sessions: [makeSession('/work/repo', { last_active: 1 })] }),
      lane({ id: 'home', isHome: true, isMain: true, label: 'release/1', sessions: [] })
    ])

    expect(labels(sorted)).toEqual(['release/1', 'main', 'feature/x', 'kanban'])
  })

  it('orders within a tier by recency, then label', () => {
    const sorted = sortWorktreeGroups([
      lane({ id: 'b', label: 'beta', sessions: [] }),
      lane({ id: 'a', label: 'alpha', sessions: [] }),
      lane({ id: 'hot', label: 'hot', sessions: [makeSession('/work/repo', { last_active: 5_000 })] })
    ])

    expect(labels(sorted)).toEqual(['hot', 'alpha', 'beta'])
  })
})

describe('mergeRepoWorktreeGroups (visual enhancer)', () => {
  const repo = { groups: [] as SidebarSessionGroup[], id: '/work/repo', path: '/work/repo' }

  it('is a no-op when no worktree probe is available', () => {
    const groups = [lane({ id: 'main-lane', isMain: true, label: 'main', path: '/work/repo' })]

    expect(mergeRepoWorktreeGroups({ ...repo, groups }, undefined)).toEqual(groups)
  })

  it('injects a session-less lane for a discovered worktree', () => {
    const merged = mergeRepoWorktreeGroups(repo, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/feature-x' })
    ])

    expect(labels(merged)).toEqual(['main', 'feature/x'])
    expect(merged.find(group => group.label === 'feature/x')?.sessions).toEqual([])
  })

  it('never gives a kanban task worktree its own lane', () => {
    const merged = mergeRepoWorktreeGroups(repo, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 't_a1b2c3', path: '/work/repo/.worktrees/t_a1b2c3' }),
      worktree({ branch: 't_d4e5f6', path: '/work/repo/.worktrees/t_d4e5f6' })
    ])

    expect(labels(merged)).toEqual(['main'])
  })

  it('relabels a dir-named lane to the branch git actually has checked out', () => {
    const groups = [lane({ id: '/work/repo/.worktrees/wt1', label: 'wt1', path: '/work/repo/.worktrees/wt1' })]

    const merged = mergeRepoWorktreeGroups({ ...repo, groups }, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/wt1' })
    ])

    expect(labels(merged)).toContain('feature/x')
    expect(labels(merged)).not.toContain('wt1')
  })

  it('re-anchors a lane whose stored path has drifted from git truth', () => {
    const groups = [lane({ id: 'stale', label: 'feature/x', path: '/work/repo/.worktrees/old' })]

    const merged = mergeRepoWorktreeGroups({ ...repo, groups }, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/new' })
    ])

    expect(merged.find(group => group.label === 'feature/x')?.path).toBe('/work/repo/.worktrees/new')
  })

  it('collapses a re-anchored lane onto the real one, keeping the richer', () => {
    const groups = [
      lane({ id: 'stale', label: 'feature/x', path: '/work/repo/.worktrees/old' }),
      lane({
        id: '/work/repo/.worktrees/new',
        label: 'new',
        path: '/work/repo/.worktrees/new',
        sessions: [makeSession('/work/repo/.worktrees/new'), makeSession('/work/repo/.worktrees/new')]
      })
    ]

    const merged = mergeRepoWorktreeGroups({ ...repo, groups }, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/new' })
    ])

    const onNewPath = merged.filter(group => group.path === '/work/repo/.worktrees/new')

    expect(onNewPath).toHaveLength(1)
    expect(onNewPath[0].sessions).toHaveLength(2)
  })

  it('keeps a detached worktree on its directory label', () => {
    const merged = mergeRepoWorktreeGroups(repo, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: null, detached: true, path: '/work/repo/.worktrees/detached-one' })
    ])

    expect(labels(merged)).toContain('detached-one')
  })

  it('folds several historical main lanes into one home lane on the live branch', () => {
    const groups = [
      lane({ id: 'm1', isMain: true, label: 'main', path: '/work/repo', sessions: [makeSession('/work/repo')] }),
      lane({ id: 'm2', isMain: true, label: 'old-branch', path: '/work/repo', sessions: [makeSession('/work/repo')] })
    ]

    const merged = mergeRepoWorktreeGroups({ ...repo, groups }, [
      worktree({ branch: 'release/2', isMain: true, path: '/work/repo' })
    ])

    const home = merged.filter(group => group.isMain)

    expect(home).toHaveLength(1)
    expect(home[0].label).toBe('release/2')
    expect(home[0].isHome).toBe(true)
    expect(home[0].sessions).toHaveLength(2)
  })

  it('dedupes a session lane and a discovered worktree on the same branch', () => {
    const groups = [
      lane({ id: '/work/repo/.worktrees/feature-x', label: 'feature/x', path: '/work/repo/.worktrees/feature-x' })
    ]

    const merged = mergeRepoWorktreeGroups({ ...repo, groups }, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 'feature/x', path: '/work/repo/.worktrees/feature-x' })
    ])

    expect(labels(merged).filter(label => label === 'feature/x')).toHaveLength(1)
  })

  it('keeps a user-named worktree under .worktrees as its own lane', () => {
    const merged = mergeRepoWorktreeGroups(repo, [
      worktree({ branch: 'main', isMain: true, path: '/work/repo' }),
      worktree({ branch: 'my-feature', path: '/work/repo/.worktrees/my-feature' })
    ])

    expect(labels(merged)).toEqual(['main', 'my-feature'])
  })
})
