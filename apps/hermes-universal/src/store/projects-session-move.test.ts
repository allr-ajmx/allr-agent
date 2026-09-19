/**
 * MJXHRM-423 — "Move to project" addressed by a pre-rotation id.
 *
 * `session.workspace.move` writes `cwd` / `git_repo_root` onto ONE row, and
 * `list_sessions_rich` projects a compression chain onto its live tip — so those
 * columns are read off the TIP no matter which segment they were written to. A
 * move addressed to the lineage root (which is what a tile tab, a mobile bubble
 * and a restored pane all hold after a compaction) updated a hidden ancestor:
 * the RPC returned ok, the row never left its old project, and the next
 * `projects.tree` put it back in the lane it started in.
 *
 * The same asymmetry as rename — and the reason both now resolve the live id at
 * their own funnel rather than trusting whatever the calling surface held.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/gateway-rpc', () => ({
  isMissingRpcMethod: () => false,
  moveSessionWorkspace: vi.fn(async () => ({ cwd: '/moved/app', git_repo_root: '/moved' }))
}))

vi.mock('@/hermes', () => ({
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  renameSession: vi.fn(),
  searchSessions: vi.fn(),
  setApiRequestProfile: vi.fn(),
  setSessionArchived: vi.fn()
}))

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn(async () => ({ projects: [] }))
  }
})

import { moveSessionWorkspace } from '@/lib/gateway-rpc'
import type { SessionInfo } from '@/types/hermes'

import { moveSessionToProject } from './projects'
import { $sessions } from './session'

afterEach(() => {
  $sessions.set([])
  vi.clearAllMocks()
})

const compacted = { _lineage_root_id: 'root', id: 'tip', cwd: '/old/app' } as unknown as SessionInfo

describe('moveSessionToProject', () => {
  it('re-homes the live tip when handed the lineage root', async () => {
    $sessions.set([compacted])

    await expect(moveSessionToProject('root', '/moved/app')).resolves.toBe(true)

    expect(moveSessionWorkspace).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/moved/app', sessionKey: 'tip' }))
  })

  // Captured from the frame the optimistic write publishes: `refreshSessions`
  // follows immediately and replaces the list with the (mocked, empty) page, so
  // reading `$sessions` after the await would prove nothing either way.
  it('patches the row the backend actually moved', async () => {
    $sessions.set([compacted])

    const frames: (readonly SessionInfo[])[] = []
    const off = $sessions.listen(next => frames.push(next))

    await moveSessionToProject('root', '/moved/app')
    off()

    expect(frames[0][0]).toMatchObject({ cwd: '/moved/app', git_repo_root: '/moved', id: 'tip' })
  })

  it('sends the id as given when no source has seen the session', async () => {
    await moveSessionToProject('unknown-1', '/moved/app')

    expect(moveSessionWorkspace).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'unknown-1' }))
  })

  it('refuses a move with no session or no destination', async () => {
    await expect(moveSessionToProject('', '/moved/app')).resolves.toBe(false)
    await expect(moveSessionToProject('root', '   ')).resolves.toBe(false)
    expect(moveSessionWorkspace).not.toHaveBeenCalled()
  })
})
