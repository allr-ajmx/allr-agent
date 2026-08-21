import { beforeEach, describe, expect, it, vi } from 'vitest'

// Observe which connect path the boot restore dials, without real networking.
vi.mock('@/store/connection', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  connectCloud: vi.fn().mockResolvedValue(undefined),
  connectLocal: vi.fn().mockResolvedValue(undefined),
  connectSsh: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  loadSavedLogin: vi.fn().mockResolvedValue({ token: 'T', password: 'P' })
}))

vi.mock('@/lib/auth', () => ({ oauthStatus: vi.fn().mockResolvedValue({ signedIn: false }) }))
vi.mock('@/store/gateway-switch-broadcast', () => ({ broadcastGatewaySwitch: vi.fn() }))

import { oauthStatus } from '@/lib/auth'
import { connect, connectCloud, connectLocal, connectSsh } from '@/store/connection'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'

import {
  $restoring,
  autoRestoreConnection,
  clearGatewayTarget,
  loadGatewayTarget,
  saveGatewayTarget,
  savePendingOAuth
} from './gateway-restore'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
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
