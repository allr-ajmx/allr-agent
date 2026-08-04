import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkAppUpdate = vi.fn()

vi.mock('@/lib/updates', () => ({ checkAppUpdate: (force: boolean) => checkAppUpdate(force) }))

import { $appUpdate, $appUpdateChecking, $appUpdateFailed, __resetUpdateState, runUpdateCheck } from './updates'

const STATUS = {
  source: 'github',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  downloadUrl: 'https://example.test/asset',
  notesUrl: 'https://example.test/release',
  checkedAtMs: 1,
  reason: null
}

describe('update store', () => {
  beforeEach(() => {
    __resetUpdateState()
    checkAppUpdate.mockReset()
  })

  it('stores the native result and clears the checking flag', async () => {
    checkAppUpdate.mockResolvedValue(STATUS)

    const pending = runUpdateCheck()
    expect($appUpdateChecking.get()).toBe(true)
    await pending

    expect($appUpdate.get()).toEqual(STATUS)
    expect($appUpdateChecking.get()).toBe(false)
    expect($appUpdateFailed.get()).toBe(false)
  })

  it('dedupes concurrent checks', async () => {
    checkAppUpdate.mockResolvedValue(STATUS)

    await Promise.all([runUpdateCheck(), runUpdateCheck(true), runUpdateCheck()])

    expect(checkAppUpdate).toHaveBeenCalledTimes(1)
  })

  it('flags a failure when the native command is unavailable', async () => {
    checkAppUpdate.mockResolvedValue(null)
    await runUpdateCheck()

    expect($appUpdate.get()).toBeNull()
    expect($appUpdateFailed.get()).toBe(true)
    expect($appUpdateChecking.get()).toBe(false)
  })

  it('survives a rejected check', async () => {
    checkAppUpdate.mockRejectedValue(new Error('boom'))
    await expect(runUpdateCheck()).resolves.toBeNull()

    expect($appUpdateFailed.get()).toBe(true)
    expect($appUpdateChecking.get()).toBe(false)
  })
})
