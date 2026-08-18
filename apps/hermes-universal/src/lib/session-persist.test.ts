import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))

import { invoke } from '@tauri-apps/api/core'

import { persistSessionCookies, restoreSessionCookies } from './session-persist'

const mockInvoke = vi.mocked(invoke)

// Both the transport commands (cookies_export/import) and the keyring plugin
// (plugin:keyring|*) route through invoke; drive them from one implementation.
type Impl = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
const setImpl = (fn: Impl) => mockInvoke.mockImplementation(fn as never)

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('session-persist', () => {
  it('persist exports the jar and writes it to the cookies keyring entry', async () => {
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    setImpl(cmd => {
      if (cmd === 'cookies_export') {
        return Promise.resolve(jar)
      }

      return Promise.resolve() // keyring init + set
    })

    await persistSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('cookies_export')
    expect(mockInvoke).toHaveBeenCalledWith('plugin:keyring|set_password', {
      username: 'cookies',
      password: jar
    })
  })

  it('persist stores nothing when the jar is empty', async () => {
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.resolve('') : Promise.resolve()))

    await persistSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('cookies_export')
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'plugin:keyring|set_password',
      expect.objectContaining({ username: 'cookies' })
    )
  })

  it('restore reads the keyring blob and imports it into the jar', async () => {
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    setImpl(cmd => {
      if (cmd === 'plugin:keyring|has_password') {
        return Promise.resolve(true)
      }

      if (cmd === 'plugin:keyring|get_password') {
        return Promise.resolve(jar)
      }

      if (cmd === 'cookies_import') {
        return Promise.resolve()
      }

      return Promise.resolve() // init
    })

    await restoreSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('cookies_import', { json: jar })
  })

  it('restore imports nothing when no blob is saved', async () => {
    setImpl(cmd => (cmd === 'plugin:keyring|has_password' ? Promise.resolve(false) : Promise.resolve()))

    await restoreSessionCookies()

    expect(mockInvoke).not.toHaveBeenCalledWith('cookies_import', expect.anything())
  })

  it('persist swallows a failing export (no runtime)', async () => {
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.reject(new Error('no runtime')) : Promise.resolve()))
    await expect(persistSessionCookies()).resolves.toBeUndefined()
  })
})
