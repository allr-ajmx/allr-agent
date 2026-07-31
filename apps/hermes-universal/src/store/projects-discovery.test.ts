import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getHermesConfig, requestGateway, scanRepos } = vi.hoisted(() => ({
  getHermesConfig: vi.fn(async () => ({}) as unknown),
  requestGateway: vi.fn(async (_method: string, _params?: unknown) => ({ active_id: null, projects: [] })),
  scanRepos: vi.fn(async () => [{ label: 'app', root: '/home/dev/app' }])
}))

vi.mock('@/lib/desktop-git', () => ({ desktopGit: vi.fn(() => ({ scanRepos })) }))
vi.mock('@/hermes', () => ({ getHermesConfig }))
// Partial mock: store/connection subscribes to `$gatewayState` at import time.
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof import('@/store/gateway')>()),
  requestGateway
}))

import {
  $reposScanning,
  repoDiscoveryPolicyFromConfig,
  repoDiscoveryPolicySignature,
  scanAndRecordRepos
} from './projects'

const recordCalls = () => requestGateway.mock.calls.filter(([method]) => method === 'projects.record_repos')

beforeEach(() => {
  scanRepos.mockClear()
  requestGateway.mockClear()
  getHermesConfig.mockReset()
  getHermesConfig.mockResolvedValue({})
  $reposScanning.set(false)
})

describe('repository discovery policy', () => {
  it('defaults to enabled with no roots when config is absent', () => {
    expect(repoDiscoveryPolicyFromConfig({})).toEqual({ enabled: true, exclude_paths: [], roots: [] })
    expect(repoDiscoveryPolicyFromConfig(null)).toEqual({ enabled: true, exclude_paths: [], roots: [] })
  })

  it('reads the desktop.repo_scan_* block and drops non-string entries', () => {
    const policy = repoDiscoveryPolicyFromConfig({
      desktop: {
        repo_scan_enabled: false,
        repo_scan_exclude_paths: ['~/Library', 7],
        repo_scan_roots: ['~/code', null, 'work']
      }
    })

    expect(policy).toEqual({
      enabled: false,
      exclude_paths: ['~/Library'],
      roots: ['~/code', 'work']
    })
  })

  it('only treats an explicit false as disabled', () => {
    expect(repoDiscoveryPolicyFromConfig({ desktop: { repo_scan_enabled: undefined } }).enabled).toBe(true)
    expect(repoDiscoveryPolicyFromConfig({ desktop: { repo_scan_enabled: false } }).enabled).toBe(false)
  })

  it('signs equal policies identically', () => {
    const policy = { enabled: true, exclude_paths: [], roots: ['~/code'] }

    expect(repoDiscoveryPolicySignature(policy)).toBe(repoDiscoveryPolicySignature({ ...policy }))
  })
})

describe('scanAndRecordRepos', () => {
  it('scans and records the crawl result with the policy that produced it', async () => {
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/code'] } })

    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledWith(['~/code'], { enabled: true, excludePaths: [] })
    expect(recordCalls()).toEqual([
      [
        'projects.record_repos',
        {
          discovery_policy: { enabled: true, exclude_paths: [], roots: ['~/code'] },
          repos: [{ label: 'app', root: '/home/dev/app' }]
        }
      ]
    ])
    expect($reposScanning.get()).toBe(false)
  })

  it('records an empty list without crawling when discovery is disabled', async () => {
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_enabled: false } })

    await scanAndRecordRepos()

    expect(scanRepos).not.toHaveBeenCalled()
    expect(recordCalls()[0]?.[1]).toMatchObject({ repos: [] })
  })

  it('skips a repeat of the same policy unless forced', async () => {
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/repeat'] } })

    await scanAndRecordRepos()
    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledTimes(1)

    await scanAndRecordRepos(true)

    expect(scanRepos).toHaveBeenCalledTimes(2)
  })

  it('rescans when the policy changes', async () => {
    // The "already ran" memo is module state that outlives one test, so use
    // roots no other case here has scanned.
    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/alpha'] } })
    await scanAndRecordRepos()

    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/beta'] } })
    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledTimes(2)
    expect(scanRepos).toHaveBeenNthCalledWith(2, ['~/beta'], { enabled: true, excludePaths: [] })
  })

  it('clears the scanning flag and stays retryable after a failure', async () => {
    getHermesConfig.mockRejectedValueOnce(new Error('offline'))

    await scanAndRecordRepos()

    expect($reposScanning.get()).toBe(false)
    expect(recordCalls()).toHaveLength(0)

    getHermesConfig.mockResolvedValue({ desktop: { repo_scan_roots: ['~/retry'] } })
    await scanAndRecordRepos()

    expect(scanRepos).toHaveBeenCalledTimes(1)
  })
})
