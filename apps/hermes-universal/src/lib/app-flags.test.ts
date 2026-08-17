import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'

const mockInvoke = vi.mocked(invoke)

// IS_TAURI is a module-level const read at call time, and both of its branches
// are real shipping paths (native store in the app, localStorage when there is
// no runtime at all). So each branch gets a fresh module graph rather than a
// mutable mock — that is what actually proves the packaged app never touches
// web storage.
async function loadWith(isTauri: boolean) {
  vi.resetModules()
  vi.doMock('@/lib/platform', () => ({ IS_TAURI: isTauri }))

  return import('./app-flags')
}

beforeEach(() => {
  mockInvoke.mockReset()
  localStorage.clear()
})

describe('app-flags with a Tauri runtime', () => {
  it('reads through to the native command', async () => {
    const { getAppFlag } = await loadWith(true)

    mockInvoke.mockResolvedValue(true as never)

    await expect(getAppFlag('connectWelcomed')).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('get_app_flag', { key: 'connectWelcomed' })
  })

  it('writes through to the native command', async () => {
    const { setAppFlag } = await loadWith(true)

    mockInvoke.mockResolvedValue(undefined as never)

    await setAppFlag('connectWelcomed', true)
    expect(mockInvoke).toHaveBeenCalledWith('set_app_flag', { key: 'connectWelcomed', value: true })
  })

  it('never touches localStorage', async () => {
    const { getAppFlag, setAppFlag } = await loadWith(true)

    mockInvoke.mockResolvedValue(false as never)

    await setAppFlag('connectWelcomed', true)
    await getAppFlag('connectWelcomed')

    // The whole point of the native store: clearing web storage must not be
    // able to resurrect a dismissed first-run screen.
    expect(localStorage.length).toBe(0)
  })

  it('resolves false when the native read rejects, rather than throwing', async () => {
    const { getAppFlag } = await loadWith(true)

    mockInvoke.mockRejectedValue(new Error('no_app_data_dir') as never)

    // An unreadable store must not stop the connect screen from rendering.
    await expect(getAppFlag('connectWelcomed')).resolves.toBe(false)
  })

  it('surfaces a failed write so a caller that awaits can see it', async () => {
    const { setAppFlag } = await loadWith(true)

    mockInvoke.mockRejectedValue(new Error('disk full') as never)

    await expect(setAppFlag('connectWelcomed', true)).rejects.toThrow('disk full')
  })
})

describe('app-flags without a Tauri runtime', () => {
  it('round-trips through localStorage and never invokes', async () => {
    const { getAppFlag, setAppFlag } = await loadWith(false)

    await expect(getAppFlag('connectWelcomed')).resolves.toBe(false)

    await setAppFlag('connectWelcomed', true)
    await expect(getAppFlag('connectWelcomed')).resolves.toBe(true)

    await setAppFlag('connectWelcomed', false)
    await expect(getAppFlag('connectWelcomed')).resolves.toBe(false)

    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
