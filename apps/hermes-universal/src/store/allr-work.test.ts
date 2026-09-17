import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AllrWorkLib from '@/lib/allr-work'

const platform = vi.hoisted(() => ({ nativeMobile: false }))

vi.mock('@/lib/platform', () => ({
  get IS_NATIVE_MOBILE() {
    return platform.nativeMobile
  }
}))
vi.mock('@/lib/allr-work', async importOriginal => {
  const real = await importOriginal<typeof AllrWorkLib>()

  return {
    ...real,
    allrWorkConfig: vi.fn().mockResolvedValue({ portalUrl: 'https://app.allr.work', parentDomain: 'allr.work' }),
    allrWorkClearSession: vi.fn().mockResolvedValue({ cleared: 3, supported: true }),
    allrWorkSignIn: vi.fn().mockResolvedValue({ busy: false, workspace: 'https://xm.allr.work' }),
    allrWorkTakeOutcome: vi.fn().mockResolvedValue(null),
    isAllrWorkSignInInFlight: vi.fn(() => false)
  }
})
vi.mock('@/lib/auth', () => ({ oauthLogout: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/connection', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $connection: atom<unknown>(null),
    connect: vi.fn().mockResolvedValue(undefined)
  }
})
vi.mock('@/store/gateway-switch-broadcast', () => ({ broadcastGatewaySwitch: vi.fn() }))

import {
  allrWorkClearSession,
  allrWorkConfig,
  AllrWorkInvokeError,
  allrWorkSignIn,
  allrWorkTakeOutcome,
  isAllrWorkSignInInFlight
} from '@/lib/allr-work'
import { oauthLogout } from '@/lib/auth'
import { $connection, connect, type Connection } from '@/store/connection'
import { saveGatewayTarget, savePendingOAuth } from '@/store/gateway-restore'
import { $gatewayMode } from '@/store/gateway-switch'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'

import {
  $allrWorkError,
  $allrWorkRestoreIssue,
  $allrWorkResume,
  $allrWorkSignInFlight,
  reconnectAllrWork,
  resumeAllrSignIn,
  signInToAllrWork,
  switchAllrWorkAccount
} from './allr-work'

const PENDING_ALLR_KEY = 'hermes.allr.pending'
const WORKSPACE = 'https://xm.allr.work'

const mockSignIn = vi.mocked(allrWorkSignIn)
const mockTake = vi.mocked(allrWorkTakeOutcome)
const mockClear = vi.mocked(allrWorkClearSession)
const mockConnect = vi.mocked(connect)
const connection = $connection as unknown as { set(value: Connection | null): void }

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  platform.nativeMobile = false
  connection.set(null)
  $gatewayMode.set('remote')
  $allrWorkError.set(null)
  $allrWorkRestoreIssue.set(null)
  $allrWorkResume.set(null)
  $allrWorkSignInFlight.set(false)
  mockSignIn.mockResolvedValue({ busy: false, workspace: WORKSPACE })
  mockTake.mockResolvedValue(null)
  // `clearAllMocks` keeps implementations; a rejecting connect must not leak between tests.
  mockConnect.mockReset()
  mockConnect.mockResolvedValue(undefined)
  vi.mocked(isAllrWorkSignInInFlight).mockReturnValue(false)
})

describe('signInToAllrWork — desktop', () => {
  it('connects to the workspace Rust signed in to, in allr mode', async () => {
    await signInToAllrWork()

    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
    // Never the interactive flag: the sign-in already happened, outside connect.
    expect(mockConnect.mock.calls[0][0]).not.toHaveProperty('allowInteractive')
    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
    expect($allrWorkSignInFlight.get()).toBe(false)
  })

  it('puts a Rust failure on the card and re-throws it without connecting', async () => {
    mockSignIn.mockRejectedValueOnce(new AllrWorkInvokeError('no-workspace', 'No workspace.'))

    await expect(signInToAllrWork()).rejects.toMatchObject({ kind: 'no-workspace' })

    expect($allrWorkError.get()).toMatchObject({ kind: 'no-workspace', message: 'No workspace.' })
    expect(mockConnect).not.toHaveBeenCalled()
    expect($allrWorkSignInFlight.get()).toBe(false)
  })

  // Closing the window is a choice. It still rejects — softSwitchGateway must roll back —
  // but nothing is shown.
  it('stays silent on a cancellation but still rejects', async () => {
    $allrWorkError.set({ kind: 'timed-out', message: 'old' })
    mockSignIn.mockRejectedValueOnce(new AllrWorkInvokeError('cancelled', 'Closed.'))

    await expect(signInToAllrWork()).rejects.toMatchObject({ kind: 'cancelled' })

    // Cleared by the new attempt, and not replaced by the cancellation.
    expect($allrWorkError.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('reports busy as GatewaySignInBusyError, not as a failure', async () => {
    mockSignIn.mockResolvedValueOnce({ busy: true, workspace: null })

    await expect(signInToAllrWork()).rejects.toMatchObject({ signInAlreadyRunning: true })

    expect($allrWorkError.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('refuses a second sign-in while one is running, without calling Rust', async () => {
    $allrWorkSignInFlight.set(true)

    await expect(signInToAllrWork()).rejects.toMatchObject({ signInAlreadyRunning: true })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('parks nothing on desktop', async () => {
    let parked: null | string = 'unset'

    mockSignIn.mockImplementationOnce(async () => {
      parked = localStorage.getItem(PENDING_ALLR_KEY)

      return { busy: false, workspace: WORKSPACE }
    })

    await signInToAllrWork()

    expect(parked).toBeNull()
    expect(mockTake).not.toHaveBeenCalled()
  })
})

// The mobile contract. The invoke navigates the calling webview away, so on a real device
// it never settles and the marker parked before it is the only thing that brings the
// result back through the reload.
describe('signInToAllrWork — mobile marker discipline', () => {
  beforeEach(() => {
    platform.nativeMobile = true
  })

  it('saves pending before invoke', async () => {
    let parked: null | string = null

    mockSignIn.mockImplementationOnce(async () => {
      parked = localStorage.getItem(PENDING_ALLR_KEY)

      return new Promise(() => {}) // the context dies here on a device
    })

    void signInToAllrWork()
    await vi.waitFor(() => expect(mockSignIn).toHaveBeenCalled())

    expect(parked).toBe('1')
  })

  // A rejection can only reach a live context: Rust refused before (or at) the first
  // navigation. The marker is garbage, and anything in the mailbox is stale.
  it('reject clears pending and discards outcome', async () => {
    mockSignIn.mockRejectedValueOnce(new AllrWorkInvokeError('already-on-sign-in-page', 'Already there.'))

    await expect(signInToAllrWork()).rejects.toMatchObject({ kind: 'already-on-sign-in-page' })

    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
    expect(mockTake).toHaveBeenCalledOnce()
    expect($allrWorkError.get()).toMatchObject({ kind: 'already-on-sign-in-page' })
  })

  // Busy is not a rejection: another Allr Work sign-in already navigated this webview, and
  // the marker IT parked is what finishes it after the reload.
  it('busy keeps pending', async () => {
    localStorage.setItem(PENDING_ALLR_KEY, '1')
    mockSignIn.mockResolvedValueOnce({ busy: true, workspace: null })

    await expect(signInToAllrWork()).rejects.toMatchObject({ signInAlreadyRunning: true })

    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBe('1')
    expect(mockTake).not.toHaveBeenCalled()
  })

  // …but when THIS call parked the marker, the surface belongs to some other flow — a remote
  // OAuth sign-in, say — and a leftover Allr marker would turn that flow's reload into an
  // Allr Work resume.
  it('busy clears a marker this call parked', async () => {
    savePendingOAuth({ base: 'https://gw.example.com' })
    mockSignIn.mockResolvedValueOnce({ busy: true, workspace: null })

    await expect(signInToAllrWork()).rejects.toMatchObject({ signInAlreadyRunning: true })

    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
    expect(localStorage.getItem('hermes.oauth.pending')).toContain('gw.example.com')
    expect(mockTake).not.toHaveBeenCalled()
  })

  it('a rejection leaves a marker it did not park', async () => {
    localStorage.setItem(PENDING_ALLR_KEY, '1')
    mockSignIn.mockRejectedValueOnce(new AllrWorkInvokeError('invalid-portal-config', 'Bad portal.'))

    await expect(signInToAllrWork()).rejects.toMatchObject({ kind: 'invalid-portal-config' })

    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBe('1')
  })

  it('a reply that did arrive connects once and leaves nothing for the next boot', async () => {
    await signInToAllrWork()

    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
    expect(mockTake).toHaveBeenCalledOnce()
  })
})

describe('switchAllrWorkAccount', () => {
  it('switch account runs logout → clear → sign-in in order', async () => {
    const order: string[] = []

    connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    vi.mocked(oauthLogout).mockImplementationOnce(async () => void order.push('logout'))
    mockClear.mockImplementationOnce(async () => {
      order.push('clear')

      return { cleared: 1, supported: true }
    })
    mockSignIn.mockImplementationOnce(async () => {
      order.push('sign-in')

      return { busy: false, workspace: 'https://other.allr.work' }
    })

    await switchAllrWorkAccount()

    expect(order).toEqual(['logout', 'clear', 'sign-in'])
    expect(oauthLogout).toHaveBeenCalledWith(WORKSPACE)
    expect(mockClear).toHaveBeenCalledWith({ workspace: WORKSPACE })
    expect(mockConnect).toHaveBeenCalledWith({ url: 'https://other.allr.work', mode: 'allr' })
  })

  it('falls back to the saved allr target when not connected, and still signs in if clearing fails', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    mockClear.mockRejectedValueOnce(new AllrWorkInvokeError('cookie-store-failed', 'Nope.'))

    await switchAllrWorkAccount()

    expect(oauthLogout).toHaveBeenCalledWith(WORKSPACE)
    expect(mockClear).toHaveBeenCalledWith({ workspace: WORKSPACE })
    expect(mockSignIn).toHaveBeenCalledOnce()
  })

  // Saved by a build pointed at another portal, or tampered: Rust would refuse a clear that
  // names it and clear NOTHING, and hop 1 would then quietly reuse the same account.
  it('clears with workspace null when the saved target is not a valid workspace, and still signs in', async () => {
    saveGatewayTarget({ mode: 'allr', url: 'https://xm.dev.allr.work' })

    await switchAllrWorkAccount()

    expect(oauthLogout).not.toHaveBeenCalled()
    expect(mockClear).toHaveBeenCalledWith({ workspace: null })
    expect(mockSignIn).toHaveBeenCalledOnce()
    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
  })

  it('clears with workspace null when the portal config cannot be read', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    vi.mocked(allrWorkConfig).mockRejectedValueOnce(new AllrWorkInvokeError('invalid-portal-config', 'Bad.'))

    await switchAllrWorkAccount()

    expect(oauthLogout).not.toHaveBeenCalled()
    expect(mockClear).toHaveBeenCalledWith({ workspace: null })
  })

  it('never names a non-allr gateway as the workspace', async () => {
    connection.set({ baseUrl: 'https://gw.example.com', mode: 'remote', authMode: 'oauth' })

    await switchAllrWorkAccount()

    expect(oauthLogout).not.toHaveBeenCalled()
    expect(mockClear).toHaveBeenCalledWith({ workspace: null })
  })

  // The cookie clear takes no lease in Rust: never while a sign-in is in flight.
  it('clears nothing while a sign-in is in flight', async () => {
    connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    $allrWorkSignInFlight.set(true)

    await expect(switchAllrWorkAccount()).rejects.toMatchObject({ signInAlreadyRunning: true })

    vi.mocked(isAllrWorkSignInInFlight).mockReturnValue(true)
    $allrWorkSignInFlight.set(false)

    await expect(switchAllrWorkAccount()).rejects.toMatchObject({ signInAlreadyRunning: true })

    expect(mockClear).not.toHaveBeenCalled()
    expect(oauthLogout).not.toHaveBeenCalled()
    expect(mockSignIn).not.toHaveBeenCalled()
  })
})

describe('reconnectAllrWork', () => {
  it('re-dials the live or saved workspace once, without signing in', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    $allrWorkRestoreIssue.set('unreachable')

    await reconnectAllrWork()

    expect(mockConnect).toHaveBeenCalledOnce()
    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('signs in when there is no workspace to re-dial', async () => {
    await reconnectAllrWork()

    expect(mockSignIn).toHaveBeenCalledOnce()
    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
  })

  it('re-classifies the card from the failure and re-throws it', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    $allrWorkRestoreIssue.set('unreachable')
    const refused = Object.assign(new Error('Sign in'), { needsInteractiveSignIn: true })
    mockConnect.mockRejectedValueOnce(refused)

    await expect(reconnectAllrWork()).rejects.toBe(refused)

    expect($allrWorkRestoreIssue.get()).toBe('session-ended')
  })

  // A resume signed in to B and could not reach it; the saved target is still A, from before.
  it('re-dials the workspace a failed resume signed in to, not the saved one', async () => {
    saveGatewayTarget({ mode: 'allr', url: 'https://old.allr.work' })
    $allrWorkResume.set({ phase: 'failed', workspace: WORKSPACE })

    await reconnectAllrWork()

    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('refuses while a sign-in is in flight, without dialling', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    $allrWorkSignInFlight.set(true)

    await expect(reconnectAllrWork()).rejects.toMatchObject({ signInAlreadyRunning: true })

    expect(mockConnect).not.toHaveBeenCalled()
  })
})

describe('resumeAllrSignIn', () => {
  const pending = () => localStorage.setItem(PENDING_ALLR_KEY, '1')

  it('does nothing — not even a mailbox read — without a marker', async () => {
    mockTake.mockResolvedValue({ kind: 'signed-in', workspace: WORKSPACE })

    await expect(resumeAllrSignIn()).resolves.toBe(false)

    expect(mockTake).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
    expect($gatewayMode.get()).toBe('remote')
  })

  it('signed-in connects allr and broadcasts the target it saved', async () => {
    pending()
    mockTake.mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    // connect() is mocked, so stand in for the target it persists on success.
    mockConnect.mockImplementationOnce(async () => saveGatewayTarget({ mode: 'allr', url: WORKSPACE }))

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($gatewayMode.get()).toBe('allr')
    expect(mockConnect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('allr', { mode: 'allr', url: WORKSPACE })
    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
  })

  // Both markers: the Allr sign-in owned the surface, so the OAuth one got `busy` and never ran.
  it('a signed-in resume discards an OAuth marker left beside it', async () => {
    pending()
    savePendingOAuth({ base: 'https://gw.example.com' })
    mockTake.mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    mockConnect.mockImplementationOnce(async () => saveGatewayTarget({ mode: 'allr', url: WORKSPACE }))

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect(localStorage.getItem('hermes.oauth.pending')).toBeNull()
    expect($gatewayMode.get()).toBe('allr')
  })

  // The credential is in the keyring; a slow radio at launch must not drop it on the card.
  it('retries a transient connect failure on the restore ladder', async () => {
    pending()
    mockTake.mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    mockConnect
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockImplementationOnce(async () => saveGatewayTarget({ mode: 'allr', url: WORKSPACE }))

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('allr', { mode: 'allr', url: WORKSPACE })
    expect($allrWorkRestoreIssue.get()).toBeNull()
  })

  it('gives up after the ladder and offers sign in again', async () => {
    pending()
    mockTake.mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    mockConnect.mockRejectedValue(new Error('HTTP 503'))

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect(mockConnect).toHaveBeenCalledTimes(3)
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect($allrWorkRestoreIssue.get()).toBe('unreachable')
  })

  it('does not broadcast a connect that failed, and marks the card', async () => {
    pending()
    mockTake.mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    mockConnect.mockRejectedValueOnce(Object.assign(new Error('Sign in'), { needsInteractiveSignIn: true }))

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    // Once: a missing credential is not retried.
    expect(mockConnect).toHaveBeenCalledOnce()

    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect($allrWorkRestoreIssue.get()).toBe('session-ended')
  })

  it('failed sets the error on the allr card and never connects', async () => {
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('workspace-unsupported', 'Too old.'),
      workspace: WORKSPACE
    })

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($gatewayMode.get()).toBe('allr')
    expect($allrWorkError.get()).toEqual({ kind: 'workspace-unsupported', message: 'Too old.', workspace: WORKSPACE })
    expect(mockConnect).not.toHaveBeenCalled()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
  })

  it('a real failure lands on the allr card even with a previous gateway saved', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('no-workspace', 'No workspace.'),
      workspace: null
    })

    // `true`: the boot stops here — no fall back to the previous gateway.
    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($gatewayMode.get()).toBe('allr')
    expect($allrWorkError.get()).toMatchObject({ kind: 'no-workspace' })
    expect(mockConnect).not.toHaveBeenCalled()
  })

  // Backing out is not a failure: go back to where the user was, like the OAuth resume.
  it('cancelled hands the boot back to the previous gateway, silently', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('cancelled', 'Backed out.'),
      workspace: null
    })

    // `false`: the ordinary restore re-dials the saved target (gateway-restore.test.ts).
    await expect(resumeAllrSignIn()).resolves.toBe(false)

    expect($gatewayMode.get()).toBe('remote')
    expect($allrWorkError.get()).toBeNull()
    expect($allrWorkRestoreIssue.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
  })

  // Backing out between the hops parks nothing, and a process killed mid-flow parks nothing.
  it('an empty mailbox hands the boot back to the previous gateway', async () => {
    saveGatewayTarget({ mode: 'ssh', ssh: { host: 'box' } })
    pending()

    await expect(resumeAllrSignIn()).resolves.toBe(false)

    expect($gatewayMode.get()).toBe('remote')
    expect($allrWorkError.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  // Both markers: an Allr Work sign-in got `busy` behind a remote OAuth sign-in that owned the
  // surface. That OAuth sign-in may have completed — its resume must run.
  it('an empty mailbox hands the boot to a pending OAuth resume', async () => {
    savePendingOAuth({ base: 'https://gw.example.com' })
    pending()

    await expect(resumeAllrSignIn()).resolves.toBe(false)

    expect($gatewayMode.get()).toBe('remote')
    expect(localStorage.getItem('hermes.oauth.pending')).toContain('gw.example.com')
  })

  it('an empty mailbox with nowhere to go back to lands on an idle allr card', async () => {
    pending()

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($gatewayMode.get()).toBe('allr')
    expect($allrWorkError.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('cancelled with nowhere to go back to lands on an idle allr card, silently', async () => {
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('cancelled', 'Backed out.'),
      workspace: null
    })

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($gatewayMode.get()).toBe('allr')
    expect($allrWorkError.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('resume is one-shot', async () => {
    pending()
    mockTake.mockResolvedValue({ kind: 'signed-in', workspace: WORKSPACE })

    const [first, second] = await Promise.all([resumeAllrSignIn(), resumeAllrSignIn()])

    expect([first, second].sort()).toEqual([false, true])
    expect(mockTake).toHaveBeenCalledOnce()
    expect(mockConnect).toHaveBeenCalledOnce()
    await expect(resumeAllrSignIn()).resolves.toBe(false)
    expect(mockConnect).toHaveBeenCalledOnce()
  })

  it('a fallback resume is one-shot too', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })
    pending()

    await expect(resumeAllrSignIn()).resolves.toBe(false)
    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()

    // Persistent, not `Once`: an unread once-value would leak into the next test.
    mockTake.mockResolvedValue({ kind: 'signed-in', workspace: WORKSPACE })
    await expect(resumeAllrSignIn()).resolves.toBe(false)

    expect(mockTake).toHaveBeenCalledOnce()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  // A back-out during a hop can reload the SPA ~2 s BEFORE Rust parks `failed(cancelled)`.
  // The first resume finds nothing; the late outcome is read by a LATER resume, and must
  // neither connect to a workspace nor show anything there.
  it('a stale cancelled outcome taken after an empty resume stays silent', async () => {
    pending()
    await expect(resumeAllrSignIn()).resolves.toBe(true)

    // Rust parks the cancellation after the reload; a later attempt's reload collects it.
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('cancelled', 'Backed out.'),
      workspace: null
    })

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($allrWorkError.get()).toBeNull()
    expect($allrWorkRestoreIssue.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockSignIn).not.toHaveBeenCalled()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
  })

  it('treats an unreadable mailbox as empty', async () => {
    pending()
    mockTake.mockRejectedValueOnce(new Error('ipc down'))

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect($allrWorkError.get()).toBeNull()
    expect(mockConnect).not.toHaveBeenCalled()
    expect(localStorage.getItem(PENDING_ALLR_KEY)).toBeNull()
  })
})

// What the connecting screen reads to name the workspace a mobile resume is about (ALLR-51 S2).
describe('resumeAllrSignIn — $allrWorkResume', () => {
  const pending = () => localStorage.setItem(PENDING_ALLR_KEY, '1')

  it('is pending from the moment the marker is taken, then dialing the signed-in workspace', async () => {
    pending()
    let seenWhileTaking: unknown = 'unread'
    let seenWhileDialing: unknown = 'unread'

    mockTake.mockImplementationOnce(async () => {
      seenWhileTaking = $allrWorkResume.get()

      return { kind: 'signed-in', workspace: WORKSPACE }
    })
    mockConnect.mockImplementationOnce(async () => {
      seenWhileDialing = $allrWorkResume.get()
    })

    await expect(resumeAllrSignIn()).resolves.toBe(true)

    expect(seenWhileTaking).toEqual({ phase: 'pending' })
    expect(seenWhileDialing).toEqual({ phase: 'dialing', workspace: WORKSPACE })
    expect($allrWorkResume.get()).toBeNull()
  })

  it('keeps the workspace once the ladder gives up', async () => {
    pending()
    mockTake.mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    mockConnect.mockRejectedValue(new Error('HTTP 503'))

    await resumeAllrSignIn()

    expect($allrWorkResume.get()).toEqual({ phase: 'failed', workspace: WORKSPACE })
  })

  it('is cleared for a resume the user backed out of', async () => {
    saveGatewayTarget({ mode: 'allr', url: 'https://old.allr.work' })
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('cancelled', 'Backed out.'),
      workspace: null
    })

    await expect(resumeAllrSignIn()).resolves.toBe(false)

    expect($allrWorkResume.get()).toBeNull()
  })

  it('is cleared for a real failure, which the card shows instead', async () => {
    pending()
    mockTake.mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('no-workspace', 'No workspace.'),
      workspace: null
    })

    await resumeAllrSignIn()

    expect($allrWorkResume.get()).toBeNull()
  })

  it('is forgotten when a new sign-in starts', async () => {
    $allrWorkResume.set({ phase: 'failed', workspace: WORKSPACE })

    await signInToAllrWork()

    expect($allrWorkResume.get()).toBeNull()
  })
})
