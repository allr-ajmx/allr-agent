import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))

import { invoke } from '@tauri-apps/api/core'

import { persistSessionCookies, restoreSessionCookies } from './session-persist'

const mockInvoke = vi.mocked(invoke)

// Both the transport commands (cookies_export/import) and the credential store
// (secrets_get/secrets_set) route through invoke; drive them from one
// implementation.
type Impl = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
const setImpl = (fn: Impl) => mockInvoke.mockImplementation(fn as never)

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('session-persist', () => {
  it('persist exports the jar and writes it to the cookies keyring entry', async () => {
    const jar = '[{"raw_cookie":"hermes_session_rt=abc"}]'
    setImpl(cmd => {
      if (cmd === 'cookies_export') {
        return Promise.resolve(jar)
      }

      return Promise.resolve() // secrets_set
    })

    await persistSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('cookies_export')
    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'cookies', value: jar })
  })

  it('persist stores nothing when the jar is empty', async () => {
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.resolve('') : Promise.resolve()))

    await persistSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('cookies_export')
    expect(mockInvoke).not.toHaveBeenCalledWith('secrets_set', expect.objectContaining({ key: 'cookies' }))
  })

  it('restore reads the keyring blob and imports it into the jar', async () => {
    const jar = '[{"raw_cookie":"hermes_session_rt=abc"}]'
    setImpl(cmd => {
      // Reads consult the unlock gate first; ungated here.
      if (cmd === 'secrets_status') {
        return Promise.resolve({ available: true, gateAvailable: false, gateEnforced: false, unlocked: false })
      }

      // One read, not a has-then-get pair: a missing entry comes back null.
      if (cmd === 'secrets_get') {
        return Promise.resolve(jar)
      }

      return Promise.resolve()
    })

    await restoreSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('cookies_import', { json: jar })
  })

  it('restore imports nothing when no blob is saved', async () => {
    setImpl(cmd => {
      if (cmd === 'secrets_status') {
        return Promise.resolve({ available: true, gateAvailable: false, gateEnforced: false, unlocked: false })
      }

      return Promise.resolve(cmd === 'secrets_get' ? null : undefined)
    })

    await restoreSessionCookies()

    expect(mockInvoke).not.toHaveBeenCalledWith('cookies_import', expect.anything())
  })

  it('persist swallows a failing export (no runtime)', async () => {
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.reject(new Error('no runtime')) : Promise.resolve()))
    await expect(persistSessionCookies()).resolves.toBeUndefined()
  })
})
