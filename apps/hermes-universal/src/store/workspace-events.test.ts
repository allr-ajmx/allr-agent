/**
 * The PROFILE half of `store/workspace-events` — the part MJXHRM-511 stage 3
 * added, plus the race it exposed.
 *
 * `/api/fs/default-cwd` is profile-scoped (stage 1): it resolves the active
 * profile's project folder → its `terminal.cwd` → the gateway default, and
 * reports that profile's `home`. So the three atoms this module owns are
 * per-profile values, and everything that reads them — the file tree, the
 * statusbar cwd segment, the terminal's initial directory, the review base —
 * is describing the wrong machine until they are reloaded.
 *
 * `store/session-states` is mocked to a bare `$focusedCwd`: `$effectiveCwd` is
 * the only thing this file needs from it, and importing the real one drags the
 * whole session graph in for a two-atom computed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { atom } from '@/store/atom'

const getDefaultCwd = vi.fn(async () => ({ branch: 'main', cwd: '/srv/default', home: '/home/gw' }))

vi.mock('@/hermes', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getDefaultCwd: () => getDefaultCwd()
}))
vi.mock('@/store/session-states', () => ({ $focusedCwd: atom('') }))

const { $activeProfile } = await import('@/store/profiles')

const {
  $workspaceBranch,
  $workspaceCwd,
  $workspaceHome,
  __workspaceProfileSyncActive,
  ensureWorkspaceCwd,
  initWorkspaceProfileSync,
  reloadWorkspaceCwd,
  resetWorkspaceCwd,
  setWorkspaceCwd,
  stopWorkspaceProfileSync
} = await import('@/store/workspace-events')

beforeEach(() => {
  stopWorkspaceProfileSync()
  resetWorkspaceCwd()
  $activeProfile.set(null)
  getDefaultCwd.mockClear()
  getDefaultCwd.mockResolvedValue({ branch: 'main', cwd: '/srv/default', home: '/home/gw' })
})

describe('ensureWorkspaceCwd', () => {
  it('loads the root, the branch and the gateway home, then memoizes', async () => {
    await expect(ensureWorkspaceCwd()).resolves.toBe('/srv/default')
    expect($workspaceCwd.get()).toBe('/srv/default')
    expect($workspaceBranch.get()).toBe('main')
    expect($workspaceHome.get()).toBe('/home/gw')

    await ensureWorkspaceCwd()
    expect(getDefaultCwd).toHaveBeenCalledTimes(1)
  })

  it('leaves `home` empty when a frozen backend omits it', async () => {
    // Additive field. Empty is what HIDES the file tree's Home button rather
    // than pointing it at ''.
    getDefaultCwd.mockResolvedValue({ branch: '', cwd: '/srv/default', home: undefined } as never)

    await ensureWorkspaceCwd()
    expect($workspaceHome.get()).toBe('')
  })
})

describe('reloadWorkspaceCwd', () => {
  it('forgets first, so the memo actually asks again', async () => {
    await ensureWorkspaceCwd()
    getDefaultCwd.mockResolvedValue({ branch: 'topic', cwd: '/srv/research', home: '/home/research' })

    await expect(reloadWorkspaceCwd()).resolves.toBe('/srv/research')
    expect($workspaceCwd.get()).toBe('/srv/research')
    expect($workspaceHome.get()).toBe('/home/research')
    expect(getDefaultCwd).toHaveBeenCalledTimes(2)
  })

  it('drops the answer to the question it stopped asking', async () => {
    // The race a reload creates and `ensureWorkspaceCwd` alone did not have: a
    // request already in the air when the scope changed still resolves. Landing
    // it would put the PREVIOUS profile's cwd on top of the new one, and its
    // `finally` would clear the successor's in-flight slot while that request
    // was still open — so the next caller would start a third.
    let releaseStale: (value: { branch: string; cwd: string; home: string }) => void = () => undefined

    getDefaultCwd.mockReturnValueOnce(
      new Promise(resolve => {
        releaseStale = resolve
      })
    )

    const stale = ensureWorkspaceCwd()

    getDefaultCwd.mockResolvedValue({ branch: 'topic', cwd: '/srv/research', home: '/home/research' })
    const fresh = reloadWorkspaceCwd()

    releaseStale({ branch: 'main', cwd: '/srv/stale', home: '/home/stale' })
    await stale
    await fresh

    expect($workspaceCwd.get()).toBe('/srv/research')
    expect($workspaceHome.get()).toBe('/home/research')
  })
})

describe('the profile sync', () => {
  it('is NOT armed by importing the module', async () => {
    expect(__workspaceProfileSyncActive()).toBe(false)

    await ensureWorkspaceCwd()
    $activeProfile.set('research')
    await Promise.resolve()

    expect(getDefaultCwd).toHaveBeenCalledTimes(1)
    expect($workspaceCwd.get()).toBe('/srv/default')
  })

  it('re-roots the workspace on a profile switch', async () => {
    initWorkspaceProfileSync()
    await ensureWorkspaceCwd()

    getDefaultCwd.mockResolvedValue({ branch: 'topic', cwd: '/srv/research', home: '/home/research' })
    $activeProfile.set('research')
    await vi.waitFor(() => expect($workspaceCwd.get()).toBe('/srv/research'))

    expect($workspaceBranch.get()).toBe('topic')
    expect($workspaceHome.get()).toBe('/home/research')
  })

  it('does not fire on the tick it is armed', async () => {
    // `listen`, not `subscribe`: subscribe delivers the current value at once,
    // which at boot would fire a second `getDefaultCwd` on top of the first.
    await ensureWorkspaceCwd()
    initWorkspaceProfileSync()
    await Promise.resolve()

    expect(getDefaultCwd).toHaveBeenCalledTimes(1)
  })

  it('arms once however many times it is called, and tears down completely', async () => {
    initWorkspaceProfileSync()
    initWorkspaceProfileSync()
    expect(__workspaceProfileSyncActive()).toBe(true)

    stopWorkspaceProfileSync()
    expect(__workspaceProfileSyncActive()).toBe(false)

    await ensureWorkspaceCwd()
    $activeProfile.set('research')
    await Promise.resolve()

    expect(getDefaultCwd).toHaveBeenCalledTimes(1)
  })
})

describe('setWorkspaceCwd', () => {
  it('re-roots the workspace and drops the branch that came with the old one', async () => {
    // The no-session half of a folder pick (`store/explorer-path`): with no
    // live session to move, `$workspaceCwd` IS `$effectiveCwd`, so this is what
    // moves the tree. The branch was read in the directory we just left, and a
    // stale one is worse than none.
    await ensureWorkspaceCwd()
    expect($workspaceBranch.get()).toBe('main')

    setWorkspaceCwd('  /srv/elsewhere  ')

    expect($workspaceCwd.get()).toBe('/srv/elsewhere')
    expect($workspaceBranch.get()).toBe('')
  })

  it('ignores a blank path rather than blanking the root', async () => {
    // Rooting the tree at '' is what the empty-state hint is for, not something
    // a click should be able to cause — the Home button's `home` is an ADDITIVE
    // field an older gateway simply omits.
    await ensureWorkspaceCwd()

    setWorkspaceCwd('   ')

    expect($workspaceCwd.get()).toBe('/srv/default')
    expect($workspaceBranch.get()).toBe('main')
  })

  it('leaves the branch alone when the path did not actually change', async () => {
    await ensureWorkspaceCwd()

    setWorkspaceCwd('/srv/default')

    expect($workspaceBranch.get()).toBe('main')
  })
})
