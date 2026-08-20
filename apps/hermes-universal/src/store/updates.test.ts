import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkAppUpdate = vi.fn()
const installAppUpdate = vi.fn<() => Promise<void>>()

vi.mock('@/lib/updates', () => ({
  checkAppUpdate: (force: boolean) => checkAppUpdate(force),
  installAppUpdate: () => installAppUpdate()
}))

import {
  $appUpdate,
  $appUpdateChecking,
  $appUpdateFailed,
  $appUpdateInstallFailed,
  $appUpdateInstalling,
  __resetUpdateState,
  runUpdateCheck,
  runUpdateInstall
} from './updates'

const STATUS = {
  source: 'updater',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  updateAvailable: true,
  downloadUrl: 'https://example.test/asset',
  notesUrl: 'https://example.test/release',
  checkedAtMs: 1,
  reason: null,
  canSelfInstall: true
}

describe('update store', () => {
  beforeEach(() => {
    __resetUpdateState()
    checkAppUpdate.mockReset()
    installAppUpdate.mockReset()
    installAppUpdate.mockResolvedValue(undefined)
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

  it('dedupes concurrent installs so a double-tap downloads once', async () => {
    installAppUpdate.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 5)))

    await Promise.all([runUpdateInstall(), runUpdateInstall()])

    expect(installAppUpdate).toHaveBeenCalledTimes(1)
  })

  it('clears the installing flag and records failure when the install fails', async () => {
    installAppUpdate.mockRejectedValue(new Error('signature mismatch'))

    await runUpdateInstall()

    expect($appUpdateInstalling.get()).toBe(false)
    expect($appUpdateInstallFailed.get()).toBe(true)
  })
})
