import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The pane operates on the FOCUSED chat's cwd ($effectiveCwd). Everything below
// is about one thing: the git refresh that follows a mutation has to land on
// THAT repo, not on whatever the sidebar has selected ($currentCwd). With two
// tiles in two worktrees those are different directories, which is the whole
// reason store/coding-status.ts is keyed per cwd.

const { commit, list, refreshRepoStatus, revert, shipInfo, stage, unstage } = vi.hoisted(() => ({
  commit: vi.fn(async () => ({ ok: true })),
  list: vi.fn(async () => ({ base: null, files: [], scope: 'uncommitted' })),
  refreshRepoStatus: vi.fn(async (_cwd?: null | string) => {}),
  revert: vi.fn(async () => ({ ok: true })),
  shipInfo: vi.fn(async () => ({ ghReady: false, pr: null })),
  stage: vi.fn(async () => ({ ok: true })),
  unstage: vi.fn(async () => ({ ok: true }))
}))

vi.mock('@/lib/desktop-git', () => ({
  desktopGit: () => ({
    review: { commit, diff: vi.fn(), list, revert, shipInfo, stage, unstage }
  })
}))
vi.mock('./coding-status', () => ({
  refreshRepoStatus,
  repoStatusForCwd: () => ({ get: () => null })
}))
vi.mock('./chat', async () => {
  const { atom } = await import('nanostores')

  return { $busy: atom(false) }
})
vi.mock('./session', async () => {
  const { atom } = await import('nanostores')

  return { $activeStoredSessionId: atom<null | string>(null), $sessions: atom<unknown[]>([]) }
})
vi.mock('./pull-requests', () => ({ stampSessionPrBranch: vi.fn() }))
vi.mock('./workspace-events', async () => {
  const { atom } = await import('nanostores')

  return { $effectiveCwd: atom(''), $workspaceChangeTick: atom(0) }
})
vi.mock('@/components/pane-shell', () => ({ PANE_TOGGLE_REVEAL_EVENT: 'pane-toggle-reveal' }))
vi.mock('@/components/pane-shell/tree/store', () => ({ revealTreePane: vi.fn() }))

import type { WritableAtom } from 'nanostores'

import { $effectiveCwd as $effectiveCwdRead } from './workspace-events'

const $effectiveCwd = $effectiveCwdRead as unknown as WritableAtom<string>

import { commitChanges, revertReviewFile, stageReviewFile, unstageReviewFile } from './review'

// The tile that has focus sits in a linked worktree; the sidebar is still on the
// primary checkout. Only the FOCUSED one may be touched by anything below.
const FOCUSED = '/repo/.worktrees/feature'

beforeEach(() => {
  refreshRepoStatus.mockClear()
  stage.mockClear()
  unstage.mockClear()
  revert.mockClear()
  commit.mockClear()
  $effectiveCwd.set(FOCUSED)
})

afterEach(() => {
  $effectiveCwd.set('')
})

describe('review mutations', () => {
  it('refreshes the repo the stage ran in', async () => {
    await stageReviewFile('src/a.ts')

    expect(stage).toHaveBeenCalledWith(FOCUSED, 'src/a.ts')
    expect(refreshRepoStatus).toHaveBeenCalledWith(FOCUSED)
  })

  it('refreshes the repo the unstage ran in', async () => {
    await unstageReviewFile(null)

    expect(unstage).toHaveBeenCalledWith(FOCUSED, null)
    expect(refreshRepoStatus).toHaveBeenCalledWith(FOCUSED)
  })

  it('refreshes the repo the discard ran in', async () => {
    await revertReviewFile('src/a.ts')

    expect(revert).toHaveBeenCalledWith(FOCUSED, 'src/a.ts')
    expect(refreshRepoStatus).toHaveBeenCalledWith(FOCUSED)
  })

  // A commit is the biggest ± move there is — everything staged drops out and
  // `ahead` climbs — so aiming its refresh at the wrong worktree is the most
  // visible form of the bug.
  it('refreshes the repo the commit ran in', async () => {
    await commitChanges('feat: something')

    expect(commit).toHaveBeenCalledWith(FOCUSED, 'feat: something', false)
    expect(refreshRepoStatus).toHaveBeenCalledWith(FOCUSED)
  })

  // `refreshRepoStatus()` with no argument falls back to the sidebar's cwd, so
  // an undefined argument is exactly the regression: it reads as "refresh
  // whatever the sidebar has", which for a focused tile is another repo.
  it('never leaves the refresh target to the sidebar', async () => {
    await stageReviewFile('src/a.ts')
    await commitChanges('feat: something')

    for (const call of refreshRepoStatus.mock.calls) {
      expect(call[0]).toBe(FOCUSED)
    }
  })
})
