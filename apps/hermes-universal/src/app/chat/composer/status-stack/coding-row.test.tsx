import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitWorktree, HermesRepoStatus } from '@/global'
import { $repoStatusByCwd, $repoWorktreesByCwd, _resetCodingStatusForTests } from '@/store/coding-status'
import type * as NotificationsModule from '@/store/notifications'
import { notifyError } from '@/store/notifications'
import { $worktreeDialog } from '@/store/projects'

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notifyError: vi.fn()
}))

// The rail registers its cwd on mount, which schedules a real probe. Answer it
// from the same fixtures the cases seed, so the follow-up refresh re-affirms
// what is on screen instead of blanking it.
vi.mock('@/lib/desktop-git', () => ({
  desktopGit: () => ({
    repoStatus: async (path: string) => $repoStatusByCwd.get()[path] ?? null,
    worktreeList: async (path: string) => $repoWorktreesByCwd.get()[path] ?? []
  })
}))

import { CodingStatusRow } from './coding-row'

const status = (over: Partial<HermesRepoStatus> = {}): HermesRepoStatus => ({
  added: 0,
  ahead: 0,
  behind: 0,
  branch: 'feature/x',
  changed: 0,
  conflicted: 0,
  defaultBranch: 'main',
  detached: false,
  files: [],
  removed: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  ...over
})

/** Seed one worktree's cached truth, the way a probe would. */
const seed = (cwd: string, over: Partial<HermesRepoStatus> = {}, worktrees: HermesGitWorktree[] = []) => {
  $repoStatusByCwd.set({ ...$repoStatusByCwd.get(), [cwd]: status(over) })
  $repoWorktreesByCwd.set({ ...$repoWorktreesByCwd.get(), [cwd]: worktrees })
}

const noop = async () => {}

// Radix's dropdown trigger opens on pointerdown, not click.
const openKebab = () =>
  fireEvent.pointerDown(screen.getAllByRole('button', { name: /new branch/i })[0], {
    button: 0,
    pointerType: 'mouse'
  })

afterEach(() => {
  cleanup()
  _resetCodingStatusForTests()
  $worktreeDialog.set(null)
  vi.mocked(notifyError).mockClear()
})

describe('CodingStatusRow', () => {
  it('renders nothing outside a repo', () => {
    const { container } = render(<CodingStatusRow repoPath="/repo" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows the branch and the +/- line delta', () => {
    seed('/repo', { added: 12, removed: 3 })

    render(<CodingStatusRow repoPath="/repo" />)

    expect(screen.getByTitle('feature/x')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  // The bug this scoping exists for: two tiles on two worktrees of one repo used
  // to paint whichever branch the SIDEBAR had selected, on both rails.
  it('paints each rail from its own worktree, not a shared global', () => {
    seed('/repo', { added: 12, branch: 'main', removed: 3 })
    seed('/repo/.worktrees/other', { added: 4, branch: 'bb/other', removed: 1 })

    render(
      <>
        <CodingStatusRow repoPath="/repo" />
        <CodingStatusRow repoPath="/repo/.worktrees/other" />
      </>
    )

    expect(screen.getByTitle('main')).toBeInTheDocument()
    expect(screen.getByTitle('bb/other')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
  })

  it('ignores another worktree becoming dirty', () => {
    seed('/repo', { added: 12, removed: 3 })

    render(<CodingStatusRow repoPath="/repo" />)

    seed('/elsewhere', { added: 99, branch: 'bb/elsewhere', removed: 7 })

    expect(screen.getByTitle('feature/x')).toBeInTheDocument()
    expect(screen.queryByText('99')).toBeNull()
  })

  it('falls back to an untracked count when nothing is tracked-dirty', () => {
    seed('/repo', { untracked: 4 })

    render(<CodingStatusRow repoPath="/repo" />)

    expect(screen.getByText(/4/)).toBeInTheDocument()
  })

  it('offers branch-off, switch and worktree entries in the kebab', async () => {
    seed('/repo', {}, [
      { branch: 'other', detached: false, isMain: false, locked: false, path: '/repo/.worktrees/other' }
    ])

    render(
      <CodingStatusRow onBranchOff={noop} onOpenWorktree={() => undefined} onSwitchBranch={noop} repoPath="/repo" />
    )

    openKebab()

    expect(await screen.findByText('New branch from feature/x')).toBeInTheDocument()
    expect(screen.getByText('New branch from main')).toBeInTheDocument()
    expect(screen.getByText('Switch to main')).toBeInTheDocument()
    expect(screen.getByText('other')).toBeInTheDocument()
  })

  it('lists only its own worktree menu entries', async () => {
    seed('/repo', {}, [
      { branch: 'mine', detached: false, isMain: false, locked: false, path: '/repo/.worktrees/mine' }
    ])
    seed('/other', { branch: 'bb/other' }, [
      { branch: 'theirs', detached: false, isMain: false, locked: false, path: '/other/.worktrees/theirs' }
    ])

    render(<CodingStatusRow onBranchOff={noop} onOpenWorktree={() => undefined} repoPath="/repo" />)

    openKebab()

    expect(await screen.findByText('mine')).toBeInTheDocument()
    expect(screen.queryByText('theirs')).toBeNull()
  })

  it('hides the kebab when branching is unavailable', () => {
    seed('/repo')

    render(<CodingStatusRow repoPath="/repo" />)

    expect(screen.queryByRole('button', { name: /new branch/i })).toBeNull()
  })

  // The row no longer mounts a dialog of its own (N rails = N stacked dialogs);
  // it publishes an intent pinned to ITS repo, and the one mounted dialog
  // renders it.
  it('publishes a worktree intent pinned to its own repo', async () => {
    seed('/repo')

    render(<CodingStatusRow onBranchOff={noop} onOpenWorktree={() => undefined} repoPath="/repo" />)

    expect($worktreeDialog.get()).toBeNull()

    openKebab()
    fireEvent.click(await screen.findByText('New branch from main'))

    await vi.waitFor(() => expect($worktreeDialog.get()).toEqual({ base: 'main', repoPath: '/repo' }))
  })

  it('toasts when switching branches fails', async () => {
    seed('/repo')
    const failure = new Error('dirty tree')

    render(
      <CodingStatusRow
        onBranchOff={noop}
        onOpenWorktree={() => undefined}
        onSwitchBranch={async () => {
          throw failure
        }}
        repoPath="/repo"
      />
    )

    openKebab()
    fireEvent.click(await screen.findByText('Switch to main'))

    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith(failure, expect.stringContaining('main')))
  })
})
