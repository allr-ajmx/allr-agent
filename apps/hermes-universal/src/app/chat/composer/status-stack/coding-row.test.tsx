import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesRepoStatus } from '@/global'
import { $repoStatus, $repoWorktrees } from '@/store/coding-status'
import type * as NotificationsModule from '@/store/notifications'
import { notifyError } from '@/store/notifications'
import { $newWorktreeRequest } from '@/store/projects'

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notifyError: vi.fn()
}))

// The dialog does its own git probing on mount; the row's behaviour is what's
// under test, so stub it down to a marker.
vi.mock('@/app/chat/sidebar/projects/worktree-dialog', () => ({
  WorktreeDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="worktree-dialog" /> : null)
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
  $newWorktreeRequest.set(0)
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
    $repoWorktrees.set([{ branch: 'other', detached: false, isMain: false, locked: false, path: '/repo/.worktrees/other' }])

    render(
      <CodingStatusRow
        onBranchOff={noop}
        onOpenWorktree={() => undefined}
        onSwitchBranch={noop}
        repoPath="/repo"
      />
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

  it('opens the worktree dialog when the ⌘⇧B token bumps', () => {
    $repoStatus.set(status())

    render(<CodingStatusRow onBranchOff={noop} onOpenWorktree={() => undefined} repoPath="/repo" />)

    expect(screen.queryByTestId('worktree-dialog')).toBeNull()

    act(() => $newWorktreeRequest.set($newWorktreeRequest.get() + 1))

    expect(screen.getByTestId('worktree-dialog')).toBeInTheDocument()
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
