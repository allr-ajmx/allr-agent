import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesRepoStatus } from '@/global'
import { $repoStatus, $repoWorktrees } from '@/store/coding-status'
import type * as NotificationsModule from '@/store/notifications'
import { notifyError } from '@/store/notifications'
import { $worktreeDialog } from '@/store/projects'

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notifyError: vi.fn()
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

const noop = async () => {}

// Radix's dropdown trigger opens on pointerdown, not click.
const openKebab = () =>
  fireEvent.pointerDown(screen.getByRole('button', { name: /new branch/i }), { button: 0, pointerType: 'mouse' })

afterEach(() => {
  cleanup()
  $repoStatus.set(null)
  $repoWorktrees.set([])
  $worktreeDialog.set(null)
  vi.mocked(notifyError).mockClear()
})

describe('CodingStatusRow', () => {
  it('renders nothing outside a repo', () => {
    const { container } = render(<CodingStatusRow repoPath="/repo" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows the branch and the +/- line delta', () => {
    $repoStatus.set(status({ added: 12, removed: 3 }))

    render(<CodingStatusRow repoPath="/repo" />)

    expect(screen.getByTitle('feature/x')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('falls back to an untracked count when nothing is tracked-dirty', () => {
    $repoStatus.set(status({ untracked: 4 }))

    render(<CodingStatusRow repoPath="/repo" />)

    expect(screen.getByText(/4/)).toBeInTheDocument()
  })

  it('offers branch-off, switch and worktree entries in the kebab', async () => {
    $repoStatus.set(status())
    $repoWorktrees.set([
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

  it('hides the kebab when branching is unavailable', () => {
    $repoStatus.set(status())

    render(<CodingStatusRow repoPath="/repo" />)

    expect(screen.queryByRole('button', { name: /new branch/i })).toBeNull()
  })

  // The row no longer mounts a dialog of its own (N rails = N stacked dialogs);
  // it publishes an intent pinned to ITS repo, and the one mounted dialog
  // renders it.
  it('publishes a worktree intent pinned to its own repo', async () => {
    $repoStatus.set(status())

    render(<CodingStatusRow onBranchOff={noop} onOpenWorktree={() => undefined} repoPath="/repo" />)

    expect($worktreeDialog.get()).toBeNull()

    openKebab()
    fireEvent.click(await screen.findByText('New branch from main'))

    await vi.waitFor(() => expect($worktreeDialog.get()).toEqual({ base: 'main', repoPath: '/repo' }))
  })

  it('toasts when switching branches fails', async () => {
    $repoStatus.set(status())
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
