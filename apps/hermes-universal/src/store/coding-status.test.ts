import type { WritableAtom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesGitWorktree, HermesRepoStatus } from '@/global'

// The store under test only needs a cwd, a busy edge and the refresh tokens, so
// the (large) chat / projects / workspace graphs are stood in for by bare atoms.
// That keeps the cases about scoping instead of about session plumbing, and lets
// each trigger be driven directly. `$busy` / `$currentCwd` / `$effectiveCwd` are
// computed in the real modules, so the stand-ins are cast back to writable here.
const { repoStatus, worktreeList } = vi.hoisted(() => ({
  repoStatus: vi.fn(async (_cwd: string) => null as HermesRepoStatus | null),
  worktreeList: vi.fn(async (_cwd: string) => [] as HermesGitWorktree[])
}))

let bridge: unknown = { repoStatus, worktreeList }

vi.mock('@/lib/desktop-git', () => ({ desktopGit: () => bridge }))
vi.mock('./chat', async () => {
  const { atom } = await import('nanostores')

  return { $busy: atom(false), $currentCwd: atom('') }
})
vi.mock('./projects', async () => {
  const { atom } = await import('nanostores')

  return {
    $projectScope: atom('__all_projects__'),
    $projectTree: atom([]),
    $worktreeDialog: atom(null),
    $worktreeRefreshToken: atom(0),
    ALL_PROJECTS: '__all_projects__',
    projectRootCwd: () => ''
  }
})
vi.mock('./workspace-events', async () => {
  const { atom } = await import('nanostores')

  return { $effectiveCwd: atom(''), $workspaceChangeTick: atom(0) }
})

import { $busy as $busyRead, $currentCwd as $currentCwdRead } from './chat'
import { $effectiveCwd as $effectiveCwdRead, $workspaceChangeTick } from './workspace-events'

const $busy = $busyRead as unknown as WritableAtom<boolean>
const $currentCwd = $currentCwdRead as unknown as WritableAtom<string>
const $effectiveCwd = $effectiveCwdRead as unknown as WritableAtom<string>

import {
  $repoChangeByPath,
  $repoStatus,
  $repoStatusByCwd,
  $repoStatusLoading,
  $repoWorktrees,
  _resetCodingStatusForTests,
  refreshRepoStatus,
  registerRepoStatusCwd,
  repoStatusForCwd,
  repoWorktreesForCwd
} from './coding-status'

const sampleStatus: HermesRepoStatus = {
  added: 12,
  ahead: 1,
  behind: 0,
  branch: 'feature/login',
  changed: 3,
  conflicted: 0,
  defaultBranch: 'main',
  detached: false,
  files: [],
  removed: 4,
  staged: 1,
  unstaged: 2,
  untracked: 0
}

const otherStatus: HermesRepoStatus = {
  ...sampleStatus,
  added: 3,
  branch: 'bb/other-worktree',
  changed: 1,
  removed: 1,
  staged: 0,
  unstaged: 1
}

const worktree = (path: string, branch: string): HermesGitWorktree => ({
  branch,
  detached: false,
  isMain: false,
  locked: false,
  path
})

/**
 * Let the debounce fire, then await whatever drain it started — WITHOUT
 * provoking a probe of our own.
 *
 * A blank target queues nothing and just hands back the in-flight drain, which
 * is exactly the passive wait we want. This used to call
 * `refreshAllRepoStatuses()`, which re-probed every target itself: the trigger
 * cases below then passed with `$workspaceChangeTick.subscribe` and the
 * turn-settle `$busy` edge deleted outright — the helper was doing the fan-out
 * they claimed to be asserting.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS)
  await refreshRepoStatus('   ')
}

const REFRESH_DEBOUNCE_MS = 200

beforeEach(() => {
  vi.useFakeTimers()
  bridge = { repoStatus, worktreeList }
  repoStatus.mockReset()
  repoStatus.mockImplementation(async () => null)
  worktreeList.mockReset()
  worktreeList.mockImplementation(async () => [])
  $currentCwd.set('')
  $effectiveCwd.set('')
  // Drain the side-effects the sets above kicked off, then start clean.
  vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS)
  _resetCodingStatusForTests()
})

afterEach(() => {
  _resetCodingStatusForTests()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('refreshRepoStatus', () => {
  it('populates the per-cwd cache and the primary view for that cwd', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/repo')
    await refreshRepoStatus('/repo')

    expect(repoStatusForCwd('/repo').get()).toEqual(sampleStatus)
    expect($repoStatus.get()).toEqual(sampleStatus)
  })

  it('falls back to the sidebar cwd when none is passed', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/active/repo')
    await refreshRepoStatus()

    expect(repoStatus).toHaveBeenCalledWith('/active/repo')
    expect($repoStatus.get()).toEqual(sampleStatus)
  })

  it('leaves the cache alone (primary reads null) when there is no cwd', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/repo')
    await refreshRepoStatus('/repo')

    // A blank target is a no-op: other worktrees' cached truth must stay put.
    await refreshRepoStatus('   ')
    expect(repoStatusForCwd('/repo').get()).toEqual(sampleStatus)

    $currentCwd.set('')
    expect($repoStatus.get()).toBeNull()
  })

  it('clears every cached status when there is no git bridge', async () => {
    $currentCwd.set('/repo')
    $repoStatusByCwd.set({ '/other': otherStatus, '/repo': sampleStatus })
    bridge = undefined
    await refreshRepoStatus('/repo')

    expect($repoStatusByCwd.get()).toEqual({})
    expect($repoStatus.get()).toBeNull()
  })

  it('clears only the failing cwd when the probe throws', async () => {
    repoStatus.mockImplementation(async cwd => {
      if (cwd === '/bad') {
        throw new Error('not a repo')
      }

      return sampleStatus
    })
    $currentCwd.set('/bad')
    $repoStatusByCwd.set({ '/bad': otherStatus, '/good': sampleStatus })
    await refreshRepoStatus('/bad')

    expect(repoStatusForCwd('/bad').get()).toBeNull()
    expect(repoStatusForCwd('/good').get()).toEqual(sampleStatus)
    expect($repoStatus.get()).toBeNull()
  })

  it('keeps independent statuses and worktree lists for two live worktrees', async () => {
    repoStatus.mockImplementation(async cwd => (cwd === '/repo-a' ? sampleStatus : otherStatus))
    worktreeList.mockImplementation(async cwd =>
      cwd === '/repo-a' ? [worktree('/repo-a', 'feature/login')] : [worktree('/repo-b', 'bb/other-worktree')]
    )

    await refreshRepoStatus('/repo-a')
    await refreshRepoStatus('/repo-b')
    await vi.runAllTicks()

    expect(repoStatusForCwd('/repo-a').get()).toEqual(sampleStatus)
    expect(repoStatusForCwd('/repo-b').get()).toEqual(otherStatus)
    expect(repoWorktreesForCwd('/repo-a').get()).toEqual([worktree('/repo-a', 'feature/login')])
    expect(repoWorktreesForCwd('/repo-b').get()).toEqual([worktree('/repo-b', 'bb/other-worktree')])

    // Two rails on two worktrees read two different branches — the whole point.
    expect(repoStatusForCwd('/repo-a').get()?.branch).not.toBe(repoStatusForCwd('/repo-b').get()?.branch)
  })

  it('returns the same atom instance for one cwd, and a shared empty one for none', () => {
    expect(repoStatusForCwd('/repo')).toBe(repoStatusForCwd('  /repo  '))
    expect(repoWorktreesForCwd('/repo')).toBe(repoWorktreesForCwd('/repo'))
    expect(repoStatusForCwd('')).toBe(repoStatusForCwd(null))
    expect(repoStatusForCwd(undefined).get()).toBeNull()
    expect(repoWorktreesForCwd(null).get()).toEqual([])
  })

  it('never publishes an old worktree status onto the primary after the cwd moves', async () => {
    let resolveOld!: (status: HermesRepoStatus | null) => void

    repoStatus.mockImplementation(
      () =>
        new Promise<HermesRepoStatus | null>(resolve => {
          resolveOld = resolve
        })
    )

    // An explicit probe (not the debounced cwd edge) so the hang is fully under
    // our control — the same race the rail hit after a session switch mid-probe.
    const inflight = refreshRepoStatus('/repo-a')

    $currentCwd.set('/repo-a')
    await Promise.resolve()

    $currentCwd.set('/repo-b')
    expect($repoStatus.get()).toBeNull()

    resolveOld(sampleStatus)
    await inflight

    // The primary follows the NEW cwd (empty). The old worktree may still cache
    // the late result under its own key — that's what lets a tile's rail paint
    // instantly — but it must not leak onto the primary.
    expect($repoStatus.get()).toBeNull()
    expect(repoStatusForCwd('/repo-a').get()).toEqual(sampleStatus)
  })

  it('runs one probe at a time and coalesces overlap into one trailing refresh per cwd', async () => {
    const resolvers: ((status: HermesRepoStatus | null) => void)[] = []
    const calls: string[] = []
    let active = 0
    let maxActive = 0

    repoStatus.mockImplementation(
      cwd =>
        new Promise<HermesRepoStatus | null>(resolve => {
          calls.push(cwd)
          active++
          maxActive = Math.max(maxActive, active)
          resolvers.push(status => {
            active--
            resolve(status)
          })
        })
    )

    $currentCwd.set('/repo-c')
    const first = refreshRepoStatus('/repo-a')
    const second = refreshRepoStatus('/repo-b')
    const third = refreshRepoStatus('/repo-c')

    expect(calls).toEqual(['/repo-a'])
    expect(maxActive).toBe(1)
    expect($repoStatusLoading.get()).toBe(true)

    resolvers.shift()?.(sampleStatus)
    await Promise.resolve()
    await Promise.resolve()

    expect(maxActive).toBe(1)
    expect(calls.length).toBe(2)

    resolvers.shift()?.(otherStatus)
    await Promise.resolve()
    await Promise.resolve()
    resolvers.shift()?.(sampleStatus)
    await Promise.all([first, second, third])

    expect(maxActive).toBe(1)
    expect(calls).toEqual(['/repo-a', '/repo-b', '/repo-c'])
    expect(repoStatusForCwd('/repo-a').get()).toEqual(sampleStatus)
    expect(repoStatusForCwd('/repo-b').get()).toEqual(otherStatus)
    expect(repoStatusForCwd('/repo-c').get()).toEqual(sampleStatus)
    expect($repoStatus.get()).toEqual(sampleStatus)
    expect($repoStatusLoading.get()).toBe(false)
  })
})

describe('registerRepoStatusCwd', () => {
  it('probes on register and keeps that worktree in unscoped refreshes', async () => {
    repoStatus.mockImplementation(async cwd => (cwd === '/tile' ? otherStatus : sampleStatus))
    $currentCwd.set('/main')

    const release = registerRepoStatusCwd('/tile')

    await settle()
    repoStatus.mockClear()

    // A tool tick is unscoped: every registered worktree re-probes, not only the
    // sidebar's.
    $workspaceChangeTick.set($workspaceChangeTick.get() + 1)
    await settle()

    const probed = [...new Set(repoStatus.mock.calls.map(call => call[0]))].sort()

    expect(probed).toEqual(['/main', '/tile'])
    expect(repoStatusForCwd('/tile').get()).toEqual(otherStatus)
    expect(repoStatusForCwd('/main').get()).toEqual(sampleStatus)
    expect($repoStatus.get()).toEqual(sampleStatus)
    expect($repoWorktrees.get()).toEqual([])

    release?.()
  })

  it('is refcounted — a second tile on the same worktree keeps it registered', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/main')

    const releaseA = registerRepoStatusCwd('/tile')
    const releaseB = registerRepoStatusCwd('/tile')

    await settle()
    releaseA?.()
    // A double release from one rail must not decrement the other's hold.
    releaseA?.()
    repoStatus.mockClear()

    $workspaceChangeTick.set($workspaceChangeTick.get() + 1)
    await settle()
    expect(repoStatus.mock.calls.map(call => call[0])).toContain('/tile')

    releaseB?.()
    repoStatus.mockClear()

    $workspaceChangeTick.set($workspaceChangeTick.get() + 1)
    await settle()
    expect(repoStatus.mock.calls.map(call => call[0])).not.toContain('/tile')
  })

  it('ignores a blank cwd', () => {
    expect(registerRepoStatusCwd('   ')).toBeUndefined()
    expect(registerRepoStatusCwd(null)).toBeUndefined()
  })

  it('re-probes every registered worktree when a turn settles', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/main')

    const release = registerRepoStatusCwd('/tile')

    await settle()
    repoStatus.mockClear()

    $busy.set(true)
    $busy.set(false)
    await settle()

    expect([...new Set(repoStatus.mock.calls.map(call => call[0]))].sort()).toEqual(['/main', '/tile'])

    release?.()
  })

  it('scopes a sidebar cwd change to that repo alone', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    const release = registerRepoStatusCwd('/tile')

    await settle()
    repoStatus.mockClear()

    $currentCwd.set('/main')
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS)

    expect(repoStatus.mock.calls.map(call => call[0])).toEqual(['/main'])

    release?.()
  })
})

// The file tree tints from $repoChangeByPath, which is keyed to the FOCUSED cwd
// — and that cwd is not always a mounted rail's: it falls back to the workspace
// root for a detached chat, and the workspace pane can be on screen with no
// composer at all. If nothing probes it, the tree shows no change decorations
// while the review pane beside it — same cwd — lists the very same files.
describe('the focused cwd', () => {
  it('is probed when focus moves to a worktree no rail registered', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/main')
    await settle()
    repoStatus.mockClear()

    $effectiveCwd.set('/focused')
    await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS)

    expect(repoStatus.mock.calls.map(call => call[0])).toEqual(['/focused'])
    expect(repoStatusForCwd('/focused').get()).toEqual(sampleStatus)
  })

  it('re-probes on an unscoped edge even though no rail holds it', async () => {
    repoStatus.mockImplementation(async () => sampleStatus)
    $currentCwd.set('/main')
    $effectiveCwd.set('/workspace-root')
    await settle()
    repoStatus.mockClear()

    // A tool touched the tree: the fan-out has to reach the focused cwd, or the
    // tree's tint freezes at whatever it had when focus landed.
    $workspaceChangeTick.set($workspaceChangeTick.get() + 1)
    await settle()

    expect([...new Set(repoStatus.mock.calls.map(call => call[0]))].sort()).toEqual(['/main', '/workspace-root'])
  })
})

describe('$repoChangeByPath', () => {
  const withFiles = (branch: string, path: string): HermesRepoStatus => ({
    ...sampleStatus,
    branch,
    files: [{ path, untracked: true } as HermesRepoStatus['files'][number]]
  })

  it('decorates the FOCUSED chat’s worktree, not the sidebar’s', () => {
    $repoStatusByCwd.set({ '/main': withFiles('main', 'a.ts'), '/tile': withFiles('bb/tile', 'b.ts') })
    $currentCwd.set('/main')
    $effectiveCwd.set('/tile')

    expect([...$repoChangeByPath.get()]).toEqual([['/tile/b.ts', 'added']])

    $effectiveCwd.set('/main')
    expect([...$repoChangeByPath.get()]).toEqual([['/main/a.ts', 'added']])
  })

  it('is empty with no focused cwd', () => {
    $repoStatusByCwd.set({ '/main': withFiles('main', 'a.ts') })
    $effectiveCwd.set('')

    expect($repoChangeByPath.get().size).toBe(0)
  })
})
