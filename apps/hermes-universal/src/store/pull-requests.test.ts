import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesBranchPullRequest } from '@/global'
import { scanSessionPullRequests } from '@/lib/gateway-rest'
import type { SessionInfo } from '@/types/hermes'

const prList = vi.fn(async (): Promise<{ ghReady: boolean; prs: HermesBranchPullRequest[] }> => ({
  ghReady: true,
  prs: []
}))

vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn(() => ({ review: { prList } })) }))

vi.mock('@/lib/gateway-rest', () => ({
  scanSessionPullRequests: vi.fn(async () => ({ pull_requests: {}, scanned: [] as string[] }))
}))

import {
  $prBranchBySession,
  $pullRequestsByBranch,
  _resetPullRequestsForTests,
  branchPrKey,
  numberPrKey,
  pullRequestBucket,
  recoverSessionPullRequests,
  refreshPullRequests,
  sessionPrKey,
  stampSessionPrBranch
} from './pull-requests'

const pr = (over: Partial<HermesBranchPullRequest> = {}): HermesBranchPullRequest => ({
  branch: 'feature/x',
  draft: false,
  number: 7,
  state: 'open',
  title: 'Add the thing',
  url: 'https://github.com/o/r/pull/7',
  ...over
})

const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    ended_at: null,
    git_branch: 'feature/x',
    git_repo_root: '/repo',
    id: 's1',
    input_tokens: 0,
    is_active: false,
    last_active: 0,
    message_count: 0,
    model: 'm',
    output_tokens: 0,
    preview: null,
    source: 'cli',
    started_at: 0,
    title: null,
    tool_call_count: 0,
    ...over
  }) as SessionInfo

beforeEach(() => {
  prList.mockClear()
  prList.mockResolvedValue({ ghReady: true, prs: [] })
  vi.mocked(scanSessionPullRequests).mockClear()
  vi.mocked(scanSessionPullRequests).mockResolvedValue({ pull_requests: {}, scanned: [] })
  _resetPullRequestsForTests()
})

describe('sessionPrKey', () => {
  it('joins the recorded repo root and branch', () => {
    expect(sessionPrKey(session())).toBe(branchPrKey('/repo', 'feature/x'))
  })

  it('never asks about a trunk branch', () => {
    // Forks share our branch namespace, so asking about `main` badges a
    // stranger's PR onto the trunk.
    expect(sessionPrKey(session({ git_branch: 'main' }))).toBeNull()
    expect(sessionPrKey(session({ git_branch: 'MASTER' }))).toBeNull()
  })

  it('prefers a stamped branch over the recorded one', () => {
    stampSessionPrBranch('s1', '/repo', 'real/branch')

    expect(sessionPrKey(session({ git_branch: 'main' }))).toBe(branchPrKey('/repo', 'real/branch'))
  })
})

describe('pullRequestBucket', () => {
  it('maps gh state onto the row buckets', () => {
    expect(pullRequestBucket(undefined)).toBe('none')
    expect(pullRequestBucket(pr())).toBe('open')
    expect(pullRequestBucket(pr({ draft: true }))).toBe('draft')
    expect(pullRequestBucket(pr({ state: 'merged' }))).toBe('merged')
    expect(pullRequestBucket(pr({ state: 'closed' }))).toBe('closed')
  })
})

describe('refreshPullRequests', () => {
  it('splits branch lookups from recovered numbers', async () => {
    await refreshPullRequests({ '/repo': ['feature/x', '#7'] })

    expect(prList).toHaveBeenCalledWith('/repo', ['feature/x'], [7])
  })

  it('keys a number lookup under both its branch and its number', async () => {
    prList.mockResolvedValue({ ghReady: true, prs: [pr()] })

    await refreshPullRequests({ '/repo': ['#7'] })

    expect($pullRequestsByBranch.get()[branchPrKey('/repo', 'feature/x')]).toEqual(pr())
    expect($pullRequestsByBranch.get()[numberPrKey('/repo', 7)]).toEqual(pr())
  })

  it('replaces a repo slice wholesale so a closed PR disappears', async () => {
    prList.mockResolvedValue({ ghReady: true, prs: [pr(), pr({ branch: 'feature/y', number: 8 })] })
    await refreshPullRequests({ '/repo': ['feature/x', 'feature/y'] })

    prList.mockResolvedValue({ ghReady: true, prs: [pr()] })
    await refreshPullRequests({ '/repo': ['feature/x'] }, true)

    expect(Object.keys($pullRequestsByBranch.get())).toEqual([branchPrKey('/repo', 'feature/x')])
  })

  it('skips a repo pulled inside the staleness window unless forced', async () => {
    await refreshPullRequests({ '/repo': ['feature/x'] })
    await refreshPullRequests({ '/repo': ['feature/x'] })

    expect(prList).toHaveBeenCalledTimes(1)

    await refreshPullRequests({ '/repo': ['feature/x'] }, true)

    expect(prList).toHaveBeenCalledTimes(2)
  })

  it('keeps what it had when gh fails', async () => {
    prList.mockResolvedValue({ ghReady: true, prs: [pr()] })
    await refreshPullRequests({ '/repo': ['feature/x'] })

    prList.mockRejectedValue(new Error('gh: not authenticated'))
    await refreshPullRequests({ '/repo': ['feature/x'] }, true)

    expect($pullRequestsByBranch.get()[branchPrKey('/repo', 'feature/x')]).toEqual(pr())
  })
})

describe('recoverSessionPullRequests', () => {
  it('stamps a recovered PR by number and never rescans', async () => {
    vi.mocked(scanSessionPullRequests).mockResolvedValue({
      pull_requests: { s1: { number: 7, url: 'https://github.com/o/r/pull/7' } },
      scanned: ['s1', 's2']
    })

    const sessions = [session({ git_branch: 'main', id: 's1' }), session({ git_branch: 'main', id: 's2' })]

    await recoverSessionPullRequests(sessions)

    expect($prBranchBySession.get().s1).toBe(numberPrKey('/repo', 7))

    await recoverSessionPullRequests(sessions)

    expect(scanSessionPullRequests).toHaveBeenCalledTimes(1)
  })

  it('stops asking once the backend has no such route', async () => {
    vi.mocked(scanSessionPullRequests).mockRejectedValue(new Error('404'))

    await recoverSessionPullRequests([session({ git_branch: 'main' })])
    await recoverSessionPullRequests([session({ git_branch: 'main', id: 's3' })])

    expect(scanSessionPullRequests).toHaveBeenCalledTimes(1)
  })
})
