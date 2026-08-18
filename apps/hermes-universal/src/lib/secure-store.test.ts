import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))

import {
  clearSecrets,
  loadSecrets,
  loadSshSecrets,
  mergeSshSecrets,
  saveSecrets,
  secureStoreAvailable,
  secureStoreUnavailableReason
} from './secure-store'

// The keystore is driven through src-tauri/src/secrets/, whose commands take a
// typed `key` rather than the arbitrary account string the old plugin accepted.
// These pin the wire contract at that boundary; the storage itself is covered by
// the Rust tests, against a real keyring-core store.

const mockInvoke = vi.mocked(invoke)

/** Stub `secrets_get` from a key→value map; everything else resolves undefined. */
function stubStore(values: Record<string, string>) {
  // `InvokeArgs` is a union that includes ArrayBuffer/number[], so narrow inside
  // rather than annotating the parameter as a record.
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'secrets_get') {
      const key = (args as undefined | { key?: string })?.key ?? ''

      return values[key] ?? null
    }

    return undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue(undefined)
})

describe('secure-store (keystore)', () => {
  it('writes token and password under their own keys', async () => {
    await saveSecrets({ token: 't', password: 'p' })

    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'token', value: 't' })
    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'password', value: 'p' })
  })

  it('clears an empty field rather than storing a blank', async () => {
    // A stored `''` reads back looking like a real, wrong credential. Rust
    // treats the empty write as a delete, which is the contract this pins.
    await saveSecrets({ token: 't' })

    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'password', value: '' })
  })

  it('reads secrets back, and reports null when there are none', async () => {
    stubStore({ token: 't', password: 'p' })
    await expect(loadSecrets()).resolves.toEqual({ token: 't', password: 'p' })

    stubStore({})
    await expect(loadSecrets()).resolves.toBeNull()
  })

  it('degrades to no-persistence when the keystore rejects, never to plaintext', async () => {
    mockInvoke.mockRejectedValue(new Error('no keystore'))

    await expect(saveSecrets({ token: 't' })).resolves.toBe(false)
    await expect(loadSecrets()).resolves.toBeNull()
    await expect(secureStoreAvailable()).resolves.toBe(false)
  })

  it('reports a failed wipe instead of claiming success', async () => {
    // The one operation whose entire job is "the credential is gone" must be
    // able to say when it is not. Six deletes behind a swallowing wrapper could
    // not, so a failed sign-out looked exactly like a clean one.
    await expect(clearSecrets()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('secrets_clear')

    mockInvoke.mockRejectedValue(new Error('the keyring refused the delete'))
    await expect(clearSecrets()).resolves.toBe(false)
  })

  it('surfaces why storage is unavailable', async () => {
    // "Your password was not saved" is only actionable with the reason attached
    // — on Linux it usually means no Secret Service daemon is running.
    mockInvoke.mockResolvedValue({ available: false, reason: 'no Secret Service' })
    await expect(secureStoreUnavailableReason()).resolves.toBe('no Secret Service')

    mockInvoke.mockResolvedValue({ available: true })
    await expect(secureStoreUnavailableReason()).resolves.toBeNull()
  })
})

describe('SSH credentials', () => {
  it('merges rather than clobbering', async () => {
    // The password only ever arrives as the answer to a mid-connect prompt, so a
    // write-all-three save from the connection form — which does not own it —
    // destroyed the one credential an unattended restore had to work with.
    await mergeSshSecrets({ passphrase: 'pp' })

    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'sshPassphrase', value: 'pp' })
    expect(mockInvoke).not.toHaveBeenCalledWith('secrets_set', expect.objectContaining({ key: 'sshPassword' }))
    expect(mockInvoke).not.toHaveBeenCalledWith('secrets_set', expect.objectContaining({ key: 'sshKey' }))
  })

  it('treats an explicit empty string as "clear this one"', async () => {
    await mergeSshSecrets({ password: '' })

    expect(mockInvoke).toHaveBeenCalledWith('secrets_set', { key: 'sshPassword', value: '' })
  })

  it('never hands back a blank credential as though it were real', async () => {
    // Some("") is a real value in Rust: an empty passphrase makes russh attempt
    // a decrypt instead of reporting that the key needs one, which silently
    // discarded every encrypted key.
    stubStore({ sshKey: 'PEM', sshPassphrase: '', sshPassword: 'pw' })

    await expect(loadSshSecrets()).resolves.toEqual({
      passphrase: undefined,
      password: 'pw',
      privateKeyPem: 'PEM'
    })
  })
})
