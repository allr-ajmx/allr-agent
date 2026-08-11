import { beforeEach, describe, expect, it, vi } from 'vitest'

// Which of the two repo-discovery crawls `desktopGit().scanRepos` picks, and what
// it is allowed to send. The walks themselves are covered where they live:
// src-tauri/src/repo_scan.rs (local) and tests/hermes_cli/test_web_repo_scan.py
// (gateway).

const { api, apiRequestProfile, localRepoScanSupported, scanLocalGitRepos } = vi.hoisted(() => ({
  api: vi.fn(async () => ({ repos: [{ label: 'gateway-app', root: '/srv/code/gateway-app' }] })),
  apiRequestProfile: vi.fn((): null | string => null),
  localRepoScanSupported: vi.fn(() => false),
  scanLocalGitRepos: vi.fn(async () => [{ label: 'app', root: '/home/dev/app' }])
}))

vi.mock('@/hermes', () => ({ apiRequestProfile }))
vi.mock('@/lib/api', () => ({ api }))
vi.mock('@/lib/gateway-rest', () => ({ listRepoPullRequests: vi.fn() }))
vi.mock('@/store/repo-scan', () => ({ localRepoScanSupported, scanLocalGitRepos }))

import { desktopGit } from './desktop-git'

const scanRepos = () => desktopGit()!.scanRepos

beforeEach(() => {
  api.mockClear()
  scanLocalGitRepos.mockClear()
  apiRequestProfile.mockReturnValue(null)
  localRepoScanSupported.mockReturnValue(false)
})

describe('desktopGit().scanRepos', () => {
  it('crawls this machine over Rust when the backend was spawned locally', async () => {
    localRepoScanSupported.mockReturnValue(true)

    const found = await scanRepos()(['~/code'], { excludePaths: ['~/Library'] })

    expect(scanLocalGitRepos).toHaveBeenCalledWith(['~/code'], { excludePaths: ['~/Library'] })
    expect(api).not.toHaveBeenCalled()
    expect(found).toEqual([{ label: 'app', root: '/home/dev/app' }])
  })

  it('crawls the gateway over REST when the local disk is not the backend disk', async () => {
    const found = await scanRepos()(['~/code'], { excludePaths: ['~/Library'] })

    expect(scanLocalGitRepos).not.toHaveBeenCalled()
    // Roots are server-side policy: the request carries none, so a client cannot
    // aim the gateway's walk at a path the operator never configured.
    expect(api).toHaveBeenCalledWith({ path: '/api/git/scan-repos', profile: null })
    expect(found).toEqual([{ label: 'gateway-app', root: '/srv/code/gateway-app' }])
  })

  it('scopes the gateway crawl to the profile the rest of the app reads config under', async () => {
    apiRequestProfile.mockReturnValue('work')

    await scanRepos()([], {})

    expect(api).toHaveBeenCalledWith({ path: '/api/git/scan-repos', profile: 'work' })
  })
})
