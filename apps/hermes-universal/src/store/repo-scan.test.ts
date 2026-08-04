import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => [{ label: 'app', root: '/home/dev/app' }]) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@/lib/platform', () => ({ IS_DESKTOP: true }))

import { $connection } from '@/store/connection'

import { localRepoScanSupported, scanLocalGitRepos } from './repo-scan'

beforeEach(() => {
  invoke.mockClear()
  $connection.set(null)
})

describe('local repo scan', () => {
  it('is supported only against a locally-spawned backend', () => {
    expect(localRepoScanSupported()).toBe(false)

    $connection.set({ authMode: 'token', baseUrl: 'http://127.0.0.1:8787', mode: 'remote', token: 't' } as never)
    expect(localRepoScanSupported()).toBe(false)

    $connection.set({ authMode: 'token', baseUrl: 'http://127.0.0.1:8787', mode: 'local', token: 't' } as never)
    expect(localRepoScanSupported()).toBe(true)
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
