import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'

import {
  ALLR_RESERVED_LABELS,
  ALLR_WORK_ERROR_KINDS,
  allrWorkClearSession,
  allrWorkConfig,
  AllrWorkInvokeError,
  allrWorkSignIn,
  allrWorkspaceBase,
  allrWorkTakeOutcome,
  isAllrWorkCancelled,
  isAllrWorkError,
  isAllrWorkSignInInFlight
} from './allr-work'

const mockInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('isAllrWorkError', () => {
  it('recognises a branded Allr Work error', () => {
    expect(isAllrWorkError(new AllrWorkInvokeError('no-workspace', 'No workspace.'))).toBe(true)
    expect(isAllrWorkCancelled(new AllrWorkInvokeError('cancelled', 'Closed.'))).toBe(true)
  })

  // `SshError` serialises as `{ kind, message }` too, and its kinds include `cancelled` and
  // `unreachable` (src-tauri/src/ssh/error.rs). Shape alone must never make an SSH failure —
  // a host-key prompt the user declined — pass for an Allr Work cancellation.
  it('does not mistake SSH errors with colliding kinds for Allr Work errors', () => {
    expect(isAllrWorkError({ kind: 'cancelled', message: 'Host key declined.' })).toBe(false)
    expect(isAllrWorkError({ kind: 'unreachable', message: 'No route to host.' })).toBe(false)
    expect(isAllrWorkCancelled({ kind: 'cancelled', message: 'Host key declined.' })).toBe(false)
  })

  it('rejects other shapes, unknown kinds, and a forged brand on an unknown kind', () => {
    expect(isAllrWorkError({ kind: 'host-key-mismatch', message: 'x', source: 'allr-work' })).toBe(false)
    expect(isAllrWorkError({ kind: 'toString', message: 'x', source: 'allr-work' })).toBe(false)
    expect(isAllrWorkError({ kind: 'cancelled', source: 'allr-work' })).toBe(false)
    expect(isAllrWorkError(new Error('cancelled'))).toBe(false)
    expect(isAllrWorkError('cancelled')).toBe(false)
    expect(isAllrWorkError(null)).toBe(false)
    expect(isAllrWorkCancelled(new AllrWorkInvokeError('timed-out', 'x'))).toBe(false)
  })

  it('lists every kind exactly once', () => {
    expect(new Set(ALLR_WORK_ERROR_KINDS).size).toBe(15)
    expect(ALLR_WORK_ERROR_KINDS).toHaveLength(15)
  })
})

// A mirror of `decide::validate_workspace`'s tests (src-tauri/src/allr_work.rs). The saved
// restore target is the one workspace URL that never passed Rust's check.
describe('allrWorkspaceBase', () => {
  const parent = 'allr.work'

  it('accepts one label under the parent, normalised', () => {
    expect(allrWorkspaceBase('https://xm.allr.work', parent)).toBe('https://xm.allr.work')
    expect(allrWorkspaceBase('https://xm.allr.work/', parent)).toBe('https://xm.allr.work')
    expect(allrWorkspaceBase('https://XM.Allr.Work', parent)).toBe('https://xm.allr.work')
    expect(allrWorkspaceBase('https://a-1.allr.work', parent)).toBe('https://a-1.allr.work')
    expect(allrWorkspaceBase(`https://${'a'.repeat(31)}.allr.work`, parent)).toBe(`https://${'a'.repeat(31)}.allr.work`)
  })

  it('accepts a dev parent', () => {
    expect(allrWorkspaceBase('https://xm.dev.allr.work', 'dev.allr.work')).toBe('https://xm.dev.allr.work')
    // …and a prod workspace is not a dev one.
    expect(allrWorkspaceBase('https://xm.allr.work', 'dev.allr.work')).toBeNull()
  })

  it.each([
    ['http', 'http://xm.allr.work'],
    ['default port', 'https://xm.allr.work:443'],
    ['other port', 'https://xm.allr.work:8443'],
    ['userinfo', 'https://u:p@xm.allr.work'],
    ['user only', 'https://u@xm.allr.work'],
    ['path', 'https://xm.allr.work/x'],
    ['double slash', 'https://xm.allr.work//'],
    ['query', 'https://xm.allr.work?q'],
    ['empty query', 'https://xm.allr.work/?'],
    ['fragment', 'https://xm.allr.work#f'],
    ['two labels', 'https://a.b.allr.work'],
    ['the parent itself', 'https://allr.work'],
    ['parent as a prefix', 'https://xm.allr.work.evil.test'],
    ['no dot boundary', 'https://xmallr.work'],
    ['trailing dot', 'https://xm.allr.work.'],
    ['IP', 'https://100.113.166.18'],
    ['leading hyphen', 'https://-xm.allr.work'],
    ['32-char label', `https://${'a'.repeat(32)}.allr.work`],
    ['underscore', 'https://x_m.allr.work'],
    ['unicode', 'https://xé.allr.work'],
    // U+212A KELVIN SIGN: WHATWG maps it to `k` in the host, and so does a full-Unicode
    // `toLowerCase` of the raw string — which made the canonical comparison pass. Rust's
    // `to_ascii_lowercase` leaves it alone and rejects.
    ['kelvin sign', 'https://\u212Am.allr.work'],
    ['whitespace', 'https://xm.allr.work\n'],
    ['not a url', 'xm.allr.work'],
    ['empty', '']
  ])('rejects %s', (_label, raw) => {
    expect(allrWorkspaceBase(raw, parent)).toBeNull()
  })

  it('rejects every reserved label', () => {
    for (const label of ALLR_RESERVED_LABELS) {
      expect(allrWorkspaceBase(`https://${label}.allr.work`, parent)).toBeNull()
    }
  })

  it('never accepts anything under an empty parent', () => {
    expect(allrWorkspaceBase('https://xm.allr.work', '')).toBeNull()
  })
})

describe('IPC wrappers', () => {
  it('call the Rust commands by name, with the clear-session workspace', async () => {
    mockInvoke.mockResolvedValue(null)

    await allrWorkConfig()
    await expect(allrWorkTakeOutcome()).resolves.toBeNull()
    await allrWorkClearSession({ workspace: 'https://xm.allr.work' })
    await allrWorkClearSession()

    expect(mockInvoke.mock.calls).toEqual([
      ['allr_work_config'],
      ['allr_work_take_outcome'],
      ['allr_work_clear_session', { workspace: 'https://xm.allr.work', switchAccount: false }],
      ['allr_work_clear_session', { workspace: null, switchAccount: false }]
    ])
  })

  // `switchAccount` asks Rust for Google's account chooser (desktop sign-in window) or to
  // forget Google's session (mobile clear). Only an explicit switch may send `true`.
  it('send switchAccount to both commands, false unless a switch asks for it', async () => {
    mockInvoke.mockResolvedValue({ busy: false, workspace: 'https://xm.allr.work', cleared: 0, supported: true })

    await allrWorkSignIn()
    await allrWorkSignIn({ switchAccount: true })
    await allrWorkClearSession({ workspace: 'https://xm.allr.work', switchAccount: true })
    await allrWorkClearSession({ switchAccount: false })

    expect(mockInvoke.mock.calls).toEqual([
      ['allr_work_sign_in', { switchAccount: false }],
      ['allr_work_sign_in', { switchAccount: true }],
      ['allr_work_clear_session', { workspace: 'https://xm.allr.work', switchAccount: true }],
      ['allr_work_clear_session', { workspace: null, switchAccount: false }]
    ])
  })

  // `allr_work_clear_session` takes no sign-in lease in Rust. Deleting the portal / Dex
  // cookies while hop 1 or hop 2 is running breaks the sign-in the user is looking at.
  it('refuses to clear the browser session while a sign-in is in flight', async () => {
    let finish: (value: unknown) => void = () => {}

    mockInvoke.mockImplementation(((cmd: string) =>
      cmd === 'allr_work_sign_in'
        ? new Promise(resolve => {
            finish = resolve
          })
        : Promise.resolve({ cleared: 0, supported: true })) as never)

    const signIn = allrWorkSignIn()

    expect(isAllrWorkSignInInFlight()).toBe(true)
    await expect(allrWorkClearSession({ workspace: 'https://xm.allr.work' })).rejects.toMatchObject({
      signInAlreadyRunning: true
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('allr_work_clear_session', expect.anything())

    finish({ busy: false, workspace: 'https://xm.allr.work' })
    await signIn

    expect(isAllrWorkSignInInFlight()).toBe(false)
    await allrWorkClearSession({ workspace: 'https://xm.allr.work' })
    expect(mockInvoke).toHaveBeenCalledWith('allr_work_clear_session', {
      workspace: 'https://xm.allr.work',
      switchAccount: false
    })
  })

  // Only the wrappers brand, so only an Allr Work command's rejection can be an Allr Work error.
  it('brands a Rust rejection from every Allr Work command', async () => {
    for (const call of [
      () => allrWorkConfig(),
      () => allrWorkSignIn(),
      () => allrWorkTakeOutcome(),
      () => allrWorkClearSession()
    ]) {
      mockInvoke.mockRejectedValueOnce({ kind: 'unreachable', message: 'Offline.' })

      const err = await call().catch((e: unknown) => e)

      expect(err).toBeInstanceOf(AllrWorkInvokeError)
      expect(isAllrWorkError(err)).toBe(true)
      expect(err).toMatchObject({ kind: 'unreachable', message: 'Offline.', source: 'allr-work' })
    }
  })

  it('passes a non-Allr rejection through unbranded', async () => {
    mockInvoke.mockRejectedValueOnce('command allr_work_config not found')

    await expect(allrWorkConfig()).rejects.toBe('command allr_work_config not found')
  })

  it("brands a parked failure's error, and drops one that is not an Allr Work error", async () => {
    mockInvoke.mockResolvedValueOnce({
      kind: 'failed',
      error: { kind: 'cancelled', message: 'Backed out.' },
      workspace: null
    })

    const outcome = await allrWorkTakeOutcome()

    expect(outcome?.kind).toBe('failed')
    expect(outcome?.kind === 'failed' && isAllrWorkCancelled(outcome.error)).toBe(true)

    mockInvoke.mockResolvedValueOnce({ kind: 'failed', error: { kind: 'bogus', message: 'x' }, workspace: null })
    await expect(allrWorkTakeOutcome()).resolves.toBeNull()

    mockInvoke.mockResolvedValueOnce({ kind: 'signed-in', workspace: 'https://xm.allr.work' })
    await expect(allrWorkTakeOutcome()).resolves.toEqual({ kind: 'signed-in', workspace: 'https://xm.allr.work' })
  })

  it('releases the in-flight count when the sign-in rejects', async () => {
    mockInvoke.mockRejectedValueOnce({ kind: 'timed-out', message: 'Too long.' })

    await expect(allrWorkSignIn()).rejects.toMatchObject({ kind: 'timed-out' })
    expect(isAllrWorkSignInInFlight()).toBe(false)
  })
})
