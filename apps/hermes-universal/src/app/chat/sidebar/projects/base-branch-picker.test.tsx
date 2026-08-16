import { cleanup, render, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitBaseBranch } from '@/global'
import { $notifications, clearNotifications } from '@/store/notifications'
import type * as ProjectsModule from '@/store/projects'
import { listBaseBranches } from '@/store/projects'

vi.mock('@/store/coding-status', () => ({
  registerRepoStatusCwd: vi.fn(() => () => {}),
  repoStatusForCwd: vi.fn(() => atom(null))
}))

vi.mock('@/store/projects', async importOriginal => ({
  ...(await importOriginal<typeof ProjectsModule>()),
  listBaseBranches: vi.fn(async (): Promise<HermesGitBaseBranch[]> => [])
}))

import { BaseBranchPicker } from './base-branch-picker'

const mount = (onValueChange: (value: string) => void) =>
  render(<BaseBranchPicker onValueChange={onValueChange} repoPath="/work/repo" value="" />)

afterEach(() => {
  clearNotifications()
  cleanup()
  vi.clearAllMocks()
})

describe('BaseBranchPicker', () => {
  it('preselects the flagged default rather than the newest branch', async () => {
    // `isDefault` is the remote trunk, and git sorts by commit date — so the
    // first row is routinely some unrelated feature branch. Taking list[0]
    // would base every new worktree on it.
    vi.mocked(listBaseBranches).mockResolvedValue([
      { isDefault: false, isRemote: true, name: 'origin/feature/newest' },
      { isDefault: true, isRemote: true, name: 'upstream/main' },
      { isDefault: false, isRemote: false, name: 'main' }
    ])
    const onValueChange = vi.fn()

    mount(onValueChange)

    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith('upstream/main'))
  })

  it('reports a failed load instead of silently basing the worktree on HEAD', async () => {
    // A non-repo folder answers with an empty list, not an error, so reaching
    // the catch really does mean the call failed. Swallowing it left the
    // trigger blank and submitted with no `base` at all — the new worktree was
    // then cut from whatever HEAD happened to be, with nothing said about it.
    vi.mocked(listBaseBranches).mockRejectedValue(new Error('gateway unreachable'))
    const onValueChange = vi.fn()

    mount(onValueChange)

    await waitFor(() => {
      const errors = $notifications.get().filter(item => item.kind === 'error')

      expect(errors.map(item => item.title)).toContain('Could not load branches')
      expect(errors.some(item => `${item.message} ${item.detail}`.includes('gateway unreachable'))).toBe(true)
    })
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
