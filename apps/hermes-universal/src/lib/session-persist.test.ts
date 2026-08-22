import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))

import { invoke } from '@tauri-apps/api/core'

import {
  forgetPersistedSessionCookies,
  persistSessionCookies,
  restoreSessionCookies
} from './session-persist'

const mockInvoke = vi.mocked(invoke)

// Both the transport commands (cookies_export/import) and the credential store
// (secrets_get/secrets_set) route through invoke; drive them from one
// implementation.
type Impl = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
const setImpl = (fn: Impl) => mockInvoke.mockImplementation(fn as never)

beforeEach(() => {
  mockInvoke.mockReset()
  // The write memo is module state and outlives a single test.
  forgetPersistedSessionCookies()
})

describe('session-persist', () => {
  it('persist exports the jar and writes it to the cookies keyring entry', async () => {
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
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
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
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

  it('persist skips the keyring write when the jar has not changed', async () => {
    // A keyring write is its own ACL check, so an unchanged jar rewritten on
    // every reconnect is a password dialog on macOS for no gain.
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.resolve(jar) : Promise.resolve()))

    await persistSessionCookies()
    await persistSessionCookies()

    const writes = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'secrets_set')

    expect(writes).toHaveLength(1)
  })

  it('persist writes again once the jar actually changes', async () => {
    let jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.resolve(jar) : Promise.resolve()))

    await persistSessionCookies()
    jar = '[{"raw_cookie":"allr_session_rt=rotated"}]'
    await persistSessionCookies()

    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'cookies', value: jar })
    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === 'secrets_set')).toHaveLength(2)
  })

  it('persist retries the write after one that did not land', async () => {
    // The memo tracks what the keyring HOLDS, not what we last tried to put
    // there. A refused write that still armed it would strand the session.
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    let failNext = true
    setImpl(cmd => {
      if (cmd === 'cookies_export') {
        return Promise.resolve(jar)
      }

      if (cmd === 'secrets_set' && failNext) {
        failNext = false

        return Promise.reject(new Error('keyring refused'))
      }

      return Promise.resolve()
    })

    await persistSessionCookies()
    await persistSessionCookies()

    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === 'secrets_set')).toHaveLength(2)
  })

  it('restore seeds the memo, so the first connect does not rewrite what it just read', async () => {
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    setImpl(cmd => {
      if (cmd === 'secrets_status') {
        return Promise.resolve({ available: true, gateAvailable: false, gateEnforced: false, unlocked: false })
      }

      if (cmd === 'secrets_get') {
        return Promise.resolve(jar)
      }

      if (cmd === 'cookies_export') {
        return Promise.resolve(jar)
      }

      return Promise.resolve()
    })

    await restoreSessionCookies()
    await persistSessionCookies()

    expect(mockInvoke).not.toHaveBeenCalledWith('secrets_set', expect.objectContaining({ key: 'cookies' }))
  })

  it('signing out clears the memo, so the next connect re-persists the jar', async () => {
    // The regression this guards: sign-out wipes the keyring entry, and a memo
    // that survived it would suppress the write that puts the jar back.
    const jar = '[{"raw_cookie":"allr_session_rt=abc"}]'
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.resolve(jar) : Promise.resolve()))

    await persistSessionCookies()
    forgetPersistedSessionCookies()
    await persistSessionCookies()

    expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === 'secrets_set')).toHaveLength(2)
  })

  it('persist swallows a failing export (no runtime)', async () => {
    setImpl(cmd => (cmd === 'cookies_export' ? Promise.reject(new Error('no runtime')) : Promise.resolve()))
    await expect(persistSessionCookies()).resolves.toBeUndefined()
  })
})
