/**
 * The wiring half of a folder pick: which of the three outcomes actually
 * touches what.
 *
 * `store/session-states` and `lib/gateway-rpc` are mocked — the first because
 * the real one drags the whole session/layout graph in for one computed, the
 * second because there is no gateway here. That means the `session.cwd.set`
 * ROUND TRIP is not proven by this file: what is proven is that the call is
 * made, that it is made with the RUNTIME id (rule 17), and that nothing else in
 * the app is painted by hand when it is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayRpcError } from '@/gateway/rpc-error'
import { atom } from '@/store/atom'
import type { ClientSessionState } from '@/store/session-state-types'

const setSessionCwd = vi.fn(async (params: { cwd: string; sessionId: string }): Promise<unknown> => params)
const notify = vi.fn((input: unknown): string => String(input && 'note'))
const openFolderAsProject = vi.fn(async (dir: string): Promise<void> => void dir)

vi.mock('@/lib/gateway-rpc', () => ({ setSessionCwd: (params: never) => setSessionCwd(params) }))
vi.mock('@/store/notifications', () => ({ notify: (input: unknown) => notify(input) }))
vi.mock('@/store/projects', () => ({ openFolderAsProject: (dir: string) => openFolderAsProject(dir) }))

const $focusedSessionState = atom<Partial<ClientSessionState>>({})

// `$focusedCwd` belongs to the same module and `store/workspace-events`
// subscribes to it at module scope for `$effectiveCwd` — a partial mock without
// it makes the computed throw on import, which is §6.4's documented trap seen
// from a different module.
vi.mock('@/store/session-states', () => ({ $focusedCwd: atom(''), $focusedSessionState }))

const { $defaultProjectDir } = await import('@/store/default-project-dir')
const { $workspaceBranch, $workspaceCwd } = await import('@/store/workspace-events')

const {
  $explorerPathPrompt,
  cancelExplorerPathPrompt,
  confirmExplorerPathDefaultOnly,
  confirmExplorerPathMoveSession,
  setExplorerPath
} = await import('@/store/explorer-path')

/** The focused slice, as `planExplorerPath` reads it. */
function focus(patch: Partial<ClientSessionState>): void {
  $focusedSessionState.set({
    awaitingResponse: false,
    busy: false,
    needsInput: false,
    runtimeSessionId: null,
    ...patch
  })
}

beforeEach(() => {
  setSessionCwd.mockReset()
  setSessionCwd.mockResolvedValue({ cwd: '/srv/work' })
  notify.mockReset()
  notify.mockReturnValue('note-1')
  openFolderAsProject.mockReset()
  openFolderAsProject.mockResolvedValue(undefined)
  $explorerPathPrompt.set(null)
  $defaultProjectDir.set(null)
  $workspaceCwd.set('/srv/original')
  $workspaceBranch.set('main')
  focus({})
})

describe('setExplorerPath with no live session', () => {
  it('re-roots the workspace and the default project dir, with no question asked', () => {
    setExplorerPath('/srv/work')

    expect($explorerPathPrompt.get()).toBeNull()
    expect($workspaceCwd.get()).toBe('/srv/work')
    expect($defaultProjectDir.get()).toBe('/srv/work')
    expect(setSessionCwd).not.toHaveBeenCalled()
  })

  it('does nothing at all for a blank path', () => {
    setExplorerPath('   ')

    expect($workspaceCwd.get()).toBe('/srv/original')
    expect($defaultProjectDir.get()).toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('setExplorerPath mid-turn', () => {
  it('explains itself and changes NOTHING — not the cwd, and not the view either', () => {
    // The whole point. Both RPCs refuse (`4009`), and re-rooting the tree anyway
    // would recreate the exact desync this change closes: a view somewhere the
    // session is not.
    focus({ busy: true, runtimeSessionId: 'runtime-1' })

    setExplorerPath('/srv/work')

    expect($explorerPathPrompt.get()).toBeNull()
    expect($workspaceCwd.get()).toBe('/srv/original')
    expect($defaultProjectDir.get()).toBeNull()
    expect(setSessionCwd).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('never puts the raw wire string in front of the user', () => {
    focus({ busy: true, runtimeSessionId: 'runtime-1' })

    setExplorerPath('/srv/work')

    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: 'warning' })
    expect(JSON.stringify(notify.mock.calls[0]?.[0])).not.toContain('session busy')
  })
})

describe('the prompt', () => {
  beforeEach(() => {
    focus({ runtimeSessionId: 'runtime-1' })
  })

  it('asks, rather than acting, when a live idle session is focused', () => {
    setExplorerPath('  /srv/work  ')

    expect($explorerPathPrompt.get()).toEqual({
      adoptProject: false,
      path: '/srv/work',
      runtimeSessionId: 'runtime-1'
    })
    expect($workspaceCwd.get()).toBe('/srv/original')
    expect($defaultProjectDir.get()).toBeNull()
  })

  it('moves the session with the RUNTIME id and paints nothing itself', async () => {
    // Rule 17, and the design: `session.cwd.set` answers with `session.info`,
    // which the reducer folds into the slice — so `$focusedCwd` → `$effectiveCwd`
    // re-roots the tree. Setting a root here as well is what made the explorer a
    // second source of truth in the first place.
    setExplorerPath('/srv/work')
    await confirmExplorerPathMoveSession()

    expect(setSessionCwd).toHaveBeenCalledWith({ cwd: '/srv/work', sessionId: 'runtime-1' })
    expect($workspaceCwd.get()).toBe('/srv/original')
    expect($defaultProjectDir.get()).toBeNull()
    expect($explorerPathPrompt.get()).toBeNull()
  })

  it('sets only the default project dir for "new chats only"', async () => {
    setExplorerPath('/srv/work')
    await confirmExplorerPathDefaultOnly()

    expect($defaultProjectDir.get()).toBe('/srv/work')
    expect(setSessionCwd).not.toHaveBeenCalled()
    // The session did not move, so neither does the tree. That is correct, not
    // a missing update.
    expect($workspaceCwd.get()).toBe('/srv/original')
  })

  it('changes nothing on cancel', async () => {
    setExplorerPath('/srv/work')
    cancelExplorerPathPrompt()
    await confirmExplorerPathMoveSession()

    expect($explorerPathPrompt.get()).toBeNull()
    expect(setSessionCwd).not.toHaveBeenCalled()
    expect($defaultProjectDir.get()).toBeNull()
  })

  it('reports a turn that started between the check and the call as busy, not as a failure', async () => {
    setSessionCwd.mockRejectedValue(new GatewayRpcError('session busy', 4009))
    setExplorerPath('/srv/work')
    await confirmExplorerPathMoveSession()

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ kind: 'warning' })
  })

  it('surfaces any other refusal as an error, with the wire text as DETAIL', async () => {
    setSessionCwd.mockRejectedValue(new GatewayRpcError('working directory does not exist: /srv/work', 4017))
    setExplorerPath('/srv/work')
    await confirmExplorerPathMoveSession()

    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      detail: 'working directory does not exist: /srv/work',
      kind: 'error'
    })
  })
})

describe('the project half', () => {
  it('adopts the folder after either answer, and after neither on cancel', async () => {
    focus({ runtimeSessionId: 'runtime-1' })

    setExplorerPath('/srv/work', { adoptProject: true })
    await confirmExplorerPathMoveSession()
    expect(openFolderAsProject).toHaveBeenCalledWith('/srv/work')

    openFolderAsProject.mockClear()
    setExplorerPath('/srv/work', { adoptProject: true })
    await confirmExplorerPathDefaultOnly()
    expect(openFolderAsProject).toHaveBeenCalledWith('/srv/work')

    openFolderAsProject.mockClear()
    setExplorerPath('/srv/work', { adoptProject: true })
    cancelExplorerPathPrompt()
    expect(openFolderAsProject).not.toHaveBeenCalled()
  })

  it('adopts it straight away when there is no session to ask about', async () => {
    setExplorerPath('/srv/work', { adoptProject: true })

    await vi.waitFor(() => expect(openFolderAsProject).toHaveBeenCalledWith('/srv/work'))
    expect($workspaceCwd.get()).toBe('/srv/work')
  })

  it('does not adopt anything when the session is mid-turn', async () => {
    // "Set as Project Folder" is one gesture, and its session half is refused —
    // adopting the project regardless would half-do it.
    focus({ busy: true, runtimeSessionId: 'runtime-1' })

    setExplorerPath('/srv/work', { adoptProject: true })
    await Promise.resolve()

    expect(openFolderAsProject).not.toHaveBeenCalled()
  })

  it('does not fail the cwd move when adopting the project throws', async () => {
    focus({ runtimeSessionId: 'runtime-1' })
    openFolderAsProject.mockRejectedValue(new Error('no projects.* RPC'))

    setExplorerPath('/srv/work', { adoptProject: true })
    await confirmExplorerPathMoveSession()

    expect(setSessionCwd).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ detail: 'no projects.* RPC', kind: 'error' })
  })
})
