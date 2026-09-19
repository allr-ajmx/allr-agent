import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AllrWorkLib from '@/lib/allr-work'

// Observe which connect path the boot restore dials, without real networking.
vi.mock('@/store/connection', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  connectCloud: vi.fn().mockResolvedValue(undefined),
  connectLocal: vi.fn().mockResolvedValue(undefined),
  connectSsh: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  loadSavedLogin: vi.fn().mockResolvedValue({ token: 'T', password: 'P' })
}))

vi.mock('@/lib/auth', () => ({
  oauthStatus: vi.fn().mockResolvedValue({ signedIn: false, reachable: true }),
  oauthStatusIsUnknown: (s: { reachable?: boolean }) => s?.reachable === false
}))
vi.mock('@/store/gateway-switch-broadcast', () => ({ broadcastGatewaySwitch: vi.fn() }))
// The Rust side of Allr Work. The pure host rule stays real — it is what decides whether a
// saved target may be dialled at all.
vi.mock('@/lib/allr-work', async importOriginal => ({
  ...(await importOriginal<typeof AllrWorkLib>()),
  allrWorkConfig: vi.fn().mockResolvedValue({ portalUrl: 'https://app.allr.work', parentDomain: 'allr.work' }),
  allrWorkTakeOutcome: vi.fn().mockResolvedValue(null)
}))

import { allrWorkConfig, AllrWorkInvokeError, allrWorkTakeOutcome } from '@/lib/allr-work'
import { oauthStatus } from '@/lib/auth'
import { $allrWorkError, $allrWorkRestoreIssue } from '@/store/allr-work-state'
import { connect, connectCloud, connectLocal, connectSsh, loadSavedLogin } from '@/store/connection'
import { $gatewayMode } from '@/store/gateway-switch'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'

import {
  $restoring,
  autoRestoreConnection,
  clearGatewayTarget,
  clearPendingAllr,
  hasPendingAllr,
  loadGatewayTarget,
  saveGatewayTarget,
  savePendingAllr,
  savePendingOAuth,
  takePendingAllr
} from './gateway-restore'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  $allrWorkError.set(null)
  $allrWorkRestoreIssue.set(null)
})

describe('gateway target persistence', () => {
  it('round-trips through localStorage', () => {
    saveGatewayTarget({ mode: 'remote', url: 'host:1', username: 'admin' })
    expect(loadGatewayTarget()).toMatchObject({ mode: 'remote', url: 'host:1', username: 'admin' })
  })

  it('clear removes it', () => {
    saveGatewayTarget({ mode: 'local' })
    clearGatewayTarget()
    expect(loadGatewayTarget()).toBeNull()
  })

  it('ignores malformed / non-mode json', () => {
    localStorage.setItem('hermes.connection.last', '{bad')
    expect(loadGatewayTarget()).toBeNull()
    localStorage.setItem('hermes.connection.last', JSON.stringify({ mode: 'bogus' }))
    expect(loadGatewayTarget()).toBeNull()
  })
})

describe('autoRestoreConnection', () => {
  it('no saved target → dials nothing and clears $restoring', async () => {
    await autoRestoreConnection()
    expect(connect).not.toHaveBeenCalled()
    expect(connectLocal).not.toHaveBeenCalled()
    expect(connectCloud).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  it('remote target → connect() with the keyring secrets', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'host:1', username: 'admin' })
    await autoRestoreConnection()
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'host:1', username: 'admin', token: 'T', password: 'P' })
    )
    expect($restoring.get()).toBe(false)
  })

  it('local target → connectLocal(profile)', async () => {
    saveGatewayTarget({ mode: 'local', profile: 'dev' })
    await autoRestoreConnection()
    expect(connectLocal).toHaveBeenCalledWith('dev')
  })

  it('cloud target → connectCloud(baseUrl)', async () => {
    saveGatewayTarget({ mode: 'cloud', cloudBaseUrl: 'https://a1', cloudAgentName: 'Atlas' })
    await autoRestoreConnection()
    expect(connectCloud).toHaveBeenCalledWith('https://a1', null)
  })

  it('clears $restoring even when the dial throws', async () => {
    vi.mocked(connect).mockRejectedValueOnce(new Error('unreachable'))
    saveGatewayTarget({ mode: 'remote', url: 'host:1' })
    await autoRestoreConnection()
    expect($restoring.get()).toBe(false)
  })
})

// On Android the sign-in navigates ONE webview away and back, which reloads the SPA —
// and that webview need not be the shell (Settings runs in its own activity). So the
// resume has to re-home the others, or they keep serving the gateway we just left.
describe('mobile oauth resume', () => {
  it('finishes the connect and tells every other WebView', async () => {
    savePendingOAuth({ base: 'https://gw.b', username: 'admin' })
    vi.mocked(oauthStatus).mockResolvedValueOnce({ signedIn: true })
    // connect() is mocked here, so stand in for the target it persists on success.
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.b' })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledWith({ url: 'https://gw.b', username: 'admin' })
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('remote', expect.objectContaining({ url: 'https://gw.b' }))
    expect($restoring.get()).toBe(false)
  })

  it('does not broadcast a connect that failed', async () => {
    savePendingOAuth({ base: 'https://gw.b' })
    vi.mocked(oauthStatus).mockResolvedValueOnce({ signedIn: true })
    vi.mocked(connect).mockRejectedValueOnce(new Error('unreachable'))
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.b' })

    await autoRestoreConnection()

    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  // The resume must not care WHICH credential came back. A native (RFC 8252) sign-in
  // leaves a bearer in the OS keyring and no cookie at all; the cookie cascade leaves
  // the reverse. `oauth_status` collapses both to `signedIn`, and this pins that the
  // frontend never looks past it — a resume that only understood cookies would send a
  // user who just completed a native sign-in straight back through the login.
  it('resumes a keyring-backed native session exactly like a cookie one', async () => {
    savePendingOAuth({ base: 'https://gw.b', username: 'admin' })
    vi.mocked(oauthStatus).mockResolvedValueOnce({ signedIn: true, sessionKind: 'native' })
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.b' })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledWith({ url: 'https://gw.b', username: 'admin' })
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('remote', expect.objectContaining({ url: 'https://gw.b' }))
    expect($restoring.get()).toBe(false)
  })

  // A cancelled login leaves the marker consumed but no session: fall through to the
  // ordinary restore rather than re-navigating into a sign-in loop.
  it('falls through when the sign-in never landed', async () => {
    savePendingOAuth({ base: 'https://gw.b' })

    await autoRestoreConnection()

    expect(connect).not.toHaveBeenCalled()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
  })
})

describe('ssh restore', () => {
  it('round-trips an ssh target, secrets excluded', () => {
    saveGatewayTarget({ mode: 'ssh', profile: null, ssh: { host: 'deploy@box', port: 2222 } })

    const loaded = loadGatewayTarget()
    expect(loaded).toMatchObject({ mode: 'ssh', ssh: { host: 'deploy@box', port: 2222 } })
    // The saved target is non-secret by contract; credentials live in the keyring.
    expect(JSON.stringify(loaded)).not.toContain('passphrase')
  })

  it('accepts ssh as a saved mode', () => {
    // Without 'ssh' in the isMode whitelist this returns null and the
    // auto-reconnect silently never happens.
    saveGatewayTarget({ mode: 'ssh', ssh: { host: 'box' } })
    expect(loadGatewayTarget()?.mode).toBe('ssh')
  })

  it('dials connectSsh non-interactively', async () => {
    saveGatewayTarget({ mode: 'ssh', profile: 'work', ssh: { host: 'deploy@box' } })
    await autoRestoreConnection()

    expect(connectSsh).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'deploy@box', profile: 'work' }),
      // The boot restore runs before any UI is mounted, so it must never be able
      // to block on a passphrase dialog nobody can answer.
      { interactive: false }
    )
    expect(connect).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  it('does not fall through to the remote path when the host is missing', async () => {
    saveGatewayTarget({ mode: 'ssh', ssh: { host: '  ' } })
    await autoRestoreConnection()

    expect(connectSsh).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(connectLocal).not.toHaveBeenCalled()
    expect(connectCloud).not.toHaveBeenCalled()
    expect($restoring.get()).toBe(false)
  })

  // ── the retry ladder ─────────────────────────────────────────────────────

  // A phone has plenty of ways to fail the first dial after launch — the radio
  // may not be up yet, DNS may not have settled, the gateway may be mid-restart —
  // and none of them mean the session is gone. This used to be a single shot, so
  // one of those dropped the user on the CONNECT screen looking signed out, even
  // though tapping Connect a second later worked.
  it('re-dials a transient failure instead of giving up on the first one', async () => {
    vi.mocked(connect).mockRejectedValueOnce(new Error('Network request failed'))
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledTimes(2)
    expect($restoring.get()).toBe(false)
  })

  // Bounded, so a gateway that is never coming back ends somewhere the user can
  // act rather than in a permanent spinner.
  it('gives up after the attempt budget and hands over to the connect screen', async () => {
    vi.mocked(connect).mockRejectedValue(new Error('Network request failed'))
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledTimes(3)
    expect($restoring.get()).toBe(false)
  })

  // A refused CREDENTIAL is not transient — asking again cannot change the answer
  // — so it must not sit behind three backoffs the user has to watch before the
  // sign-in affordance appears.
  it('spends the ladder immediately when a sign-in is required', async () => {
    const needsSignIn = Object.assign(new Error('Sign in to https://gw.example.com to continue'), {
      needsInteractiveSignIn: true
    })

    vi.mocked(connect).mockRejectedValue(needsSignIn)
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    await autoRestoreConnection()

    // Once, not three times. Retrying cannot conjure a credential, and each
    // retry used to be another interactive sign-in — three of them inside one
    // second, which is what the device log records as "refusing a second
    // sign-in for webview \"main\"".
    expect(connect).toHaveBeenCalledTimes(1)
    expect($restoring.get()).toBe(false)
  })

  // The restore must never be the thing that opens a login page.
  it('never asks the boot dial to open a login page', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ allowInteractive: false }))
  })

  it('spends the ladder immediately when the credential is refused', async () => {
    const expired = Object.assign(new Error('Session expired — sign in again'), {
      needsOauthLogin: true
    })

    vi.mocked(connect).mockRejectedValue(expired)
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledTimes(1)
    expect($restoring.get()).toBe(false)
  })
})

// ── Allr Work (ALLR-51) ───────────────────────────────────────────────────────

// Earlier suites leave rejecting implementations behind (`clearAllMocks` keeps them).
const resetDial = () => {
  vi.mocked(connect).mockReset()
  vi.mocked(connect).mockResolvedValue(undefined)
}

describe('allr restore', () => {
  const WORKSPACE = 'https://xm.allr.work'

  beforeEach(resetDial)
  const signInRequired = () => Object.assign(new Error('Sign in to Allr Work'), { needsInteractiveSignIn: true })

  it('accepts an allr target', () => {
    // Without 'allr' in the isMode whitelist this returns null and the auto-reconnect
    // silently never happens.
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    expect(loadGatewayTarget()).toEqual({ mode: 'allr', url: WORKSPACE })
  })

  it('dials allr non-interactively', async () => {
    saveGatewayTarget({ mode: 'allr', url: `${WORKSPACE}/` })

    await autoRestoreConnection()

    // Exactly this: the normalised base, the allr path, never interactive, and none of the
    // remote card's keyring secrets.
    expect(connect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr', allowInteractive: false })
    expect(loadSavedLogin).not.toHaveBeenCalled()
    expect($gatewayMode.get()).toBe('allr')
    expect($restoring.get()).toBe(false)
    expect($allrWorkRestoreIssue.get()).toBeNull()
  })

  // localStorage is not Rust's host rule. A saved target that fails it is never dialled.
  it.each([
    ['another domain', 'https://xm.evil.test'],
    ['a reserved label', 'https://auth.allr.work'],
    ['a nested host', 'https://a.b.allr.work'],
    ['plain http', 'http://xm.allr.work'],
    ['a missing url', undefined]
  ])('refuses to dial a saved workspace on %s and asks for a sign-in', async (_label, url) => {
    saveGatewayTarget({ mode: 'allr', url })

    await autoRestoreConnection()

    expect(connect).not.toHaveBeenCalled()
    expect($allrWorkRestoreIssue.get()).toBe('session-ended')
    expect($restoring.get()).toBe(false)
  })

  it('validates against the configured parent, not a hard-coded one', async () => {
    vi.mocked(allrWorkConfig).mockResolvedValueOnce({
      portalUrl: 'https://app.dev.allr.work',
      parentDomain: 'dev.allr.work'
    })
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })

    await autoRestoreConnection()

    expect(connect).not.toHaveBeenCalled()
    expect($allrWorkRestoreIssue.get()).toBe('session-ended')
  })

  it('fails closed when the portal config cannot be read', async () => {
    vi.mocked(allrWorkConfig).mockRejectedValueOnce(new AllrWorkInvokeError('invalid-portal-config', 'Bad portal.'))
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })

    await autoRestoreConnection()

    expect(connect).not.toHaveBeenCalled()
  })

  it('a refused refresh token ends the ladder at once and says the session ended', async () => {
    vi.mocked(connect).mockRejectedValue(signInRequired())
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledTimes(1)
    expect($allrWorkRestoreIssue.get()).toBe('session-ended')
  })

  // An invalid-but-unexpired bearer comes back from an Allr workspace as 503 — "unknown",
  // retried like a network fault. Once the ladder is spent the card must offer Sign in
  // again, or the user retries a dead credential forever.
  it('an exhausted ladder of unknown failures offers sign in again', async () => {
    vi.mocked(connect).mockRejectedValue(new Error('Auth provider unreachable (HTTP 503)'))
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledTimes(3)
    expect($allrWorkRestoreIssue.get()).toBe('unreachable')
    expect($restoring.get()).toBe(false)
  })

  it('never marks the allr card for a restore of another mode', async () => {
    vi.mocked(connect).mockRejectedValue(signInRequired())
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })

    await autoRestoreConnection()

    expect($allrWorkRestoreIssue.get()).toBeNull()
  })
})

describe('allr pending marker', () => {
  it('is one-shot', () => {
    expect(hasPendingAllr()).toBe(false)
    savePendingAllr()
    expect(hasPendingAllr()).toBe(true)
    expect(takePendingAllr()).toBe(true)
    expect(takePendingAllr()).toBe(false)
    savePendingAllr()
    clearPendingAllr()
    expect(hasPendingAllr()).toBe(false)
  })

  it('$restoring seeds from pending allr', async () => {
    localStorage.setItem('hermes.allr.pending', '1')
    vi.resetModules()

    const fresh = await import('./gateway-restore')

    expect(fresh.$restoring.get()).toBe(true)
  })
})

// On mobile the sign-in reloads the SPA; the boot restore finishes it from Rust's mailbox.
describe('mobile allr resume', () => {
  const WORKSPACE = 'https://xm.allr.work'

  beforeEach(resetDial)

  it('resume signed-in connects allr and broadcasts', async () => {
    savePendingAllr()
    vi.mocked(allrWorkTakeOutcome).mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })
    vi.mocked(connect).mockImplementationOnce(async () => saveGatewayTarget({ mode: 'allr', url: WORKSPACE }))

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' })
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('allr', { mode: 'allr', url: WORKSPACE })
    expect($gatewayMode.get()).toBe('allr')
    expect($restoring.get()).toBe(false)
  })

  // A REAL failure: land on the Allr Work card with it, not back on the gateway saved
  // before the attempt.
  it('resume failed sets error and does not connect', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com' })
    savePendingAllr()
    vi.mocked(allrWorkTakeOutcome).mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('timed-out', 'Too long.'),
      workspace: null
    })

    await autoRestoreConnection()

    expect(connect).not.toHaveBeenCalled()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect($allrWorkError.get()).toMatchObject({ kind: 'timed-out' })
    expect($gatewayMode.get()).toBe('allr')
    expect($restoring.get()).toBe(false)
  })

  // Backing out is not a failure. Like the OAuth resume's fallback: re-dial the gateway the
  // user was on before the attempt, through the ordinary non-interactive restore, holding
  // `$restoring` (the connecting screen) up across that dial.
  it('cancelled re-dials the previous target with its mode, silently', async () => {
    saveGatewayTarget({ mode: 'remote', url: 'https://gw.example.com', username: 'admin' })
    savePendingAllr()
    $restoring.set(true)
    vi.mocked(allrWorkTakeOutcome).mockResolvedValueOnce({
      kind: 'failed',
      error: new AllrWorkInvokeError('cancelled', 'Backed out.'),
      workspace: null
    })
    let restoringDuringDial: boolean | null = null

    vi.mocked(connect).mockImplementationOnce(async () => {
      restoringDuringDial = $restoring.get()
    })

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://gw.example.com', username: 'admin', allowInteractive: false })
    )
    expect(connect).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'allr' }))
    expect($gatewayMode.get()).toBe('remote')
    expect(restoringDuringDial).toBe(true)
    expect($restoring.get()).toBe(false)
    expect($allrWorkError.get()).toBeNull()
    expect($allrWorkRestoreIssue.get()).toBeNull()
    expect(broadcastGatewaySwitch).not.toHaveBeenCalled()
    expect(hasPendingAllr()).toBe(false)
  })

  it('an empty mailbox re-dials the previous target with its mode', async () => {
    saveGatewayTarget({ mode: 'local', profile: 'dev' })
    savePendingAllr()

    await autoRestoreConnection()

    expect(connectLocal).toHaveBeenCalledWith('dev')
    expect(connect).not.toHaveBeenCalled()
    expect($gatewayMode.get()).toBe('local')
    expect($allrWorkError.get()).toBeNull()
    expect($restoring.get()).toBe(false)
    expect(hasPendingAllr()).toBe(false)
  })

  // Retrying after backing out of a switch-account / sign-in-again on an Allr workspace: the
  // previous target is that workspace, and it comes back the same silent way.
  it('an empty mailbox re-dials a previous allr workspace too', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    savePendingAllr()

    await autoRestoreConnection()

    expect(connect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr', allowInteractive: false })
    expect($gatewayMode.get()).toBe('allr')
    expect($allrWorkError.get()).toBeNull()
  })

  it('an empty mailbox with no previous target lands idle on the allr card', async () => {
    savePendingAllr()
    $restoring.set(true)

    await autoRestoreConnection()

    expect(connect).not.toHaveBeenCalled()
    expect(connectLocal).not.toHaveBeenCalled()
    expect(connectCloud).not.toHaveBeenCalled()
    expect(connectSsh).not.toHaveBeenCalled()
    expect($gatewayMode.get()).toBe('allr')
    expect($allrWorkError.get()).toBeNull()
    expect($allrWorkRestoreIssue.get()).toBeNull()
    expect($restoring.get()).toBe(false)
  })

  it('resume is one-shot', async () => {
    savePendingAllr()
    vi.mocked(allrWorkTakeOutcome).mockResolvedValue({ kind: 'signed-in', workspace: WORKSPACE })

    await autoRestoreConnection()
    await autoRestoreConnection()

    expect(allrWorkTakeOutcome).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledOnce()
    vi.mocked(allrWorkTakeOutcome).mockResolvedValue(null)
  })

  // Both markers: the Allr Work sign-in got `busy` behind a remote OAuth sign-in that owned
  // the surface, and that OAuth sign-in completed. With nothing in the Allr mailbox and no
  // saved target, the OAuth resume must still run — not be skipped for an idle Allr card
  // with its marker left to fire on some later boot.
  it('an empty allr resume still lets a completed OAuth sign-in resume', async () => {
    savePendingAllr()
    savePendingOAuth({ base: 'https://gw.b', username: 'admin' })
    vi.mocked(oauthStatus).mockResolvedValueOnce({ signedIn: true })
    vi.mocked(connect).mockImplementationOnce(async () => saveGatewayTarget({ mode: 'remote', url: 'https://gw.b' }))

    await autoRestoreConnection()

    expect(oauthStatus).toHaveBeenCalledWith('https://gw.b')
    expect(connect).toHaveBeenCalledWith({ url: 'https://gw.b', username: 'admin' })
    expect(broadcastGatewaySwitch).toHaveBeenCalledWith('remote', expect.objectContaining({ url: 'https://gw.b' }))
    expect($gatewayMode.get()).toBe('remote')
    expect(localStorage.getItem('hermes.oauth.pending')).toBeNull()
    expect(hasPendingAllr()).toBe(false)
    expect($restoring.get()).toBe(false)
  })

  it('with no marker, a signed-in outcome in the mailbox is never read', async () => {
    vi.mocked(allrWorkTakeOutcome).mockResolvedValueOnce({ kind: 'signed-in', workspace: WORKSPACE })

    await autoRestoreConnection()

    expect(allrWorkTakeOutcome).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    vi.mocked(allrWorkTakeOutcome).mockReset()
    vi.mocked(allrWorkTakeOutcome).mockResolvedValue(null)
  })
})
