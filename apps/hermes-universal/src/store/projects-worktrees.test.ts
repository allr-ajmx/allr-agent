import { beforeEach, describe, expect, it, vi } from 'vitest'

import { desktopGit } from '@/lib/desktop-git'
import { selectDesktopPaths } from '@/lib/desktop-fs'

const bridge = {
  baseBranchList: vi.fn(async () => [{ isDefault: true, isRemote: true, name: 'origin/main' }]),
  branchList: vi.fn(async () => [{ checkedOut: false, isDefault: false, name: 'feature/x', worktreePath: null }]),
  branchSwitch: vi.fn(async () => ({ branch: 'main' })),
  worktreeAdd: vi.fn(async () => ({ branch: 'feature/x', path: '/repo/.worktrees/feature-x', repoRoot: '/repo' })),
  worktreeRemove: vi.fn(async () => ({ removed: '/repo/.worktrees/feature-x' }))
}

vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn(() => bridge) }))

vi.mock('@/lib/desktop-fs', () => ({
  copyTextToClipboard: vi.fn(async () => {}),
  desktopDefaultCwd: vi.fn(async () => ({ branch: 'main', cwd: '/work' })),
  selectDesktopPaths: vi.fn(async () => ['/work/picked'])
}))

import {
  $newWorktreeRequest,
  $startWorkSessionRequest,
  $worktreeRefreshToken,
  listBaseBranches,
  listRepoBranches,
  removeWorktreePath,
  requestNewWorktree,
  pickProjectFolder,
  requestStartWorkSession,
  startWorkInRepo,
  switchBranchInRepo
} from './projects'

beforeEach(() => {
  Object.values(bridge).forEach(fn => fn.mockClear())
  vi.mocked(desktopGit).mockReturnValue(bridge as never)
  $worktreeRefreshToken.set(0)
  $startWorkSessionRequest.set(null)
  $newWorktreeRequest.set(0)
})

describe('projects store — worktree ops', () => {
  it('creates a worktree and bumps the refresh token', async () => {
    const result = await startWorkInRepo('/repo', { base: 'main', branch: 'feature/x', name: 'feature/x' })

    expect(bridge.worktreeAdd).toHaveBeenCalledWith('/repo', { base: 'main', branch: 'feature/x', name: 'feature/x' })
    expect(result).toEqual({ branch: 'feature/x', path: '/repo/.worktrees/feature-x' })
    expect($worktreeRefreshToken.get()).toBe(1)
  })

  it('switches a branch and bumps the refresh token', async () => {
    await switchBranchInRepo('/repo', 'main')

    expect(bridge.branchSwitch).toHaveBeenCalledWith('/repo', 'main')
    expect($worktreeRefreshToken.get()).toBe(1)
  })

  it('ignores a blank branch or missing repo without touching git', async () => {
    await switchBranchInRepo('/repo', '   ')
    await switchBranchInRepo('', 'main')
    await startWorkInRepo('')

    expect(bridge.branchSwitch).not.toHaveBeenCalled()
    expect(bridge.worktreeAdd).not.toHaveBeenCalled()
    expect($worktreeRefreshToken.get()).toBe(0)
  })

  it('removes a worktree and bumps the refresh token', async () => {
    await removeWorktreePath('/repo', '/repo/.worktrees/feature-x', { force: true })

    expect(bridge.worktreeRemove).toHaveBeenCalledWith('/repo', '/repo/.worktrees/feature-x', { force: true })
    expect($worktreeRefreshToken.get()).toBe(1)
  })

  it('lists branches, and returns empty with no bridge', async () => {
    expect(await listRepoBranches('/repo')).toHaveLength(1)
    expect(await listBaseBranches('/repo')).toHaveLength(1)

    vi.mocked(desktopGit).mockReturnValue(undefined)

    expect(await listRepoBranches('/repo')).toEqual([])
    expect(await listBaseBranches('/repo')).toEqual([])
  })

  it('re-fires the start-work request on a repeat path via a fresh token', () => {
    requestStartWorkSession('/repo/.worktrees/feature-x', ' fix the flake ')
    const first = $startWorkSessionRequest.get()

    requestStartWorkSession('/repo/.worktrees/feature-x')
    const second = $startWorkSessionRequest.get()

    expect(first).toMatchObject({ draft: 'fix the flake', path: '/repo/.worktrees/feature-x' })
    expect(second?.draft).toBeUndefined()
    expect(second!.token).toBeGreaterThan(first!.token)
  })

  it('ignores a blank start-work path', () => {
    requestStartWorkSession('  ')

    expect($startWorkSessionRequest.get()).toBeNull()
  })

  it('picks a project folder through the remote-aware picker, seeded at the backend cwd', async () => {
    expect(await pickProjectFolder()).toBe('/work/picked')
    expect(selectDesktopPaths).toHaveBeenCalledWith({ defaultPath: '/work', directories: true, multiple: false })
  })

  it('treats an empty pick as cancelled', async () => {
    vi.mocked(selectDesktopPaths).mockResolvedValueOnce([])

    expect(await pickProjectFolder()).toBeNull()
  })

  it('bumps the new-worktree hotkey token', () => {
    requestNewWorktree()
    requestNewWorktree()

    expect($newWorktreeRequest.get()).toBe(2)
  })
})
