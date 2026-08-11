import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitBranch } from '@/global'
import { $notifications, clearNotifications } from '@/store/notifications'
import type * as ProjectsModule from '@/store/projects'
import { $worktreeDialog, listRepoBranches, startWorkInRepo } from '@/store/projects'

vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsModule>()),
  listRepoBranches: vi.fn(async () => []),
  requestStartWorkSession: vi.fn(),
  startWorkInRepo: vi.fn(async () => ({ branch: 'x', path: '/work/repo/.worktrees/x', repoRoot: '/work/repo' })),
  switchBranchInRepo: vi.fn(async () => {})
}))

import { branchActionLabel, WorktreeDialog } from './worktree-dialog'

const copy = {
  branchCreateWorktree: 'new worktree',
  branchOpenExisting: 'open',
  branchSwitchHome: 'switch home',
  branchTrackRemote: 'track remote'
}

const branch = (over: Partial<HermesGitBranch> & Pick<HermesGitBranch, 'name'>): HermesGitBranch => ({
  checkedOut: false,
  isDefault: false,
  worktreePath: null,
  ...over
})

// Open the dialog and switch it into "convert a branch" mode.
const openConvertMode = async () => {
  render(<WorktreeDialog />)
  $worktreeDialog.set({ repoPath: '/work/repo' })
  fireEvent.click(await screen.findByText('Convert an existing branch'))
}

describe('branchActionLabel', () => {
  it('promises tracking, not a plain worktree, for a remote-only branch', () => {
    // A remote-only row makes a LOCAL branch that tracks the remote one — a
    // different act from checking out a branch that is already here, so it must
    // not borrow the "new worktree" label.
    expect(branchActionLabel(branch({ isRemote: true, name: 'origin/feature/x' }), copy)).toBe('track remote')
    expect(branchActionLabel(branch({ name: 'feature/x' }), copy)).toBe('new worktree')
    expect(branchActionLabel(branch({ isDefault: true, name: 'main' }), copy)).toBe('switch home')
  })

  it('prefers an existing checkout over the remote label', () => {
    // `checkedOut` wins: nothing needs tracking when the branch is already out.
    expect(branchActionLabel(branch({ checkedOut: true, isRemote: true, name: 'main' }), copy)).toBe('open')
  })

  it('treats a gateway that omits isRemote as local', () => {
    // The field is optional so an older gateway (pre-remote-branch support)
    // still renders — its rows are all local heads.
    expect(branchActionLabel(branch({ name: 'feature/x' }), copy)).toBe('new worktree')
  })
})

describe('WorktreeDialog convert mode', () => {
  beforeEach(() => {
    vi.mocked(listRepoBranches).mockResolvedValue([
      branch({ isRemote: false, name: 'main', isDefault: true }),
      branch({ isRemote: true, name: 'origin/feature/remote-only' })
    ])
  })

  afterEach(() => {
    $worktreeDialog.set(null)
    clearNotifications()
    cleanup()
    vi.clearAllMocks()
  })

  it('labels a remote-only branch as tracking the remote', async () => {
    await openConvertMode()

    const row = (await screen.findByText('origin/feature/remote-only')).closest('button')

    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('track remote')
    // The remote glyph, matching the base-branch picker.
    expect(row!.querySelector('.codicon-repo')).not.toBeNull()
    // A local row keeps the branch glyph.
    expect(screen.getByText('main').closest('button')!.querySelector('.codicon-git-branch')).not.toBeNull()
  })

  it('hands the remote-tracking name to the gateway, which resolves it', async () => {
    await openConvertMode()

    fireEvent.click(await screen.findByText('origin/feature/remote-only'))

    await waitFor(() =>
      expect(vi.mocked(startWorkInRepo)).toHaveBeenCalledWith('/work/repo', {
        existingBranch: 'origin/feature/remote-only'
      })
    )
  })

  it('reports a failed branch load instead of showing an empty repo', async () => {
    vi.mocked(listRepoBranches).mockRejectedValue(new Error('gateway unreachable'))

    await openConvertMode()

    // The placeholder alone is indistinguishable from a repo with no branches,
    // so the error has to reach the notification surface.
    expect(await screen.findByText('No branches found')).toBeTruthy()
    await waitFor(() => {
      const errors = $notifications.get().filter(item => item.kind === 'error')

      expect(errors.map(item => item.title)).toContain('Could not load branches')
      expect(errors.some(item => `${item.message} ${item.detail}`.includes('gateway unreachable'))).toBe(true)
    })
  })
})
