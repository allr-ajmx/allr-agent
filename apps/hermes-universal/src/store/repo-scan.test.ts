import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, platform } = vi.hoisted(() => ({
  invoke: vi.fn(async () => [{ label: 'app', root: '/home/dev/app' }]),
  platform: { isDesktop: true }
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
// A getter, not a constant: both halves of the gate have to be exercisable, and
// mobile-vs-desktop is the half a fixed `IS_DESKTOP: true` can never reach.
vi.mock('@/lib/platform', () => ({
  get IS_DESKTOP() {
    return platform.isDesktop
  }
}))

import { $connection } from '@/store/connection'

import { localRepoScanSupported, scanLocalGitRepos } from './repo-scan'

const connect = (mode: string) =>
  $connection.set({ authMode: 'token', baseUrl: 'http://127.0.0.1:8787', mode, token: 't' } as never)

beforeEach(() => {
  invoke.mockClear()
  platform.isDesktop = true
  $connection.set(null)
})

describe('local repo scan', () => {
  it('is supported only against a locally-spawned backend', () => {
    expect(localRepoScanSupported()).toBe(false)

    connect('remote')
    expect(localRepoScanSupported()).toBe(false)

    connect('local')
    expect(localRepoScanSupported()).toBe(true)
  })

  it('is never supported on mobile, which has no crawlable disk', () => {
    // The Rust command answers `unsupported_platform` there, so routing a mobile
    // client into it would surface a rejection instead of the gateway's crawl.
    // `mode` alone must not be enough to open this door.
    platform.isDesktop = false
    connect('local')

    expect(localRepoScanSupported()).toBe(false)
  })

  it('passes the policy through to the Rust command, nulling absent options', async () => {
    await scanLocalGitRepos(['~/code'], { excludePaths: ['~/Library'] })

    expect(invoke).toHaveBeenCalledWith('repo_scan_git_repos', {
      enabled: null,
      excludePaths: ['~/Library'],
      maxDepth: null,
      roots: ['~/code']
    })
  })
})
