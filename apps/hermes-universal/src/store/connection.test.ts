import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AllrWorkLib from '@/lib/allr-work'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  passwordLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogout: vi.fn().mockResolvedValue(undefined),
  oauthStatus: vi.fn().mockResolvedValue({ signedIn: false }),
  oauthStatusIsUnknown: (s: { reachable?: boolean }) => s?.reachable === false,
  fetchAuthProviders: vi.fn().mockResolvedValue([]),
  portalLogout: vi.fn().mockResolvedValue(undefined),
  portalAgentSignIn: vi.fn().mockResolvedValue({ connected: true, baseUrl: 'https://a1' })
}))
vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    connectGateway: vi.fn().mockResolvedValue(undefined),
    closeGateway: vi.fn(),
    lastGatewayCloseCode: vi.fn(() => undefined),
    $gatewayState: atom('idle')
  }
})
vi.mock('@/lib/secure-store', () => ({
  saveSecrets: vi.fn().mockResolvedValue(true),
  loadSecrets: vi.fn().mockResolvedValue({ token: 'T', password: 'P' }),
  clearSecrets: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/session-persist', () => ({
  clearSessionJar: vi.fn().mockResolvedValue(undefined),
  forgetPersistedSessionCookies: vi.fn(),
  persistSessionCookies: vi.fn().mockResolvedValue(undefined),
  resumeSessionCookiePersistence: vi.fn(),
  suspendSessionCookiePersistence: vi.fn()
}))
vi.mock('@/store/local-backend', () => ({
  spawnLocalBackend: vi.fn(),
  stopLocalBackend: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/allr-work', async importOriginal => ({
  ...(await importOriginal<typeof AllrWorkLib>()),
  allrWorkClearSession: vi.fn().mockResolvedValue({ cleared: 2, supported: true }),
  allrWorkConfig: vi.fn().mockResolvedValue({ portalUrl: 'https://app.allr.work', parentDomain: 'allr.work' }),
  isAllrWorkSignInInFlight: vi.fn(() => false)
}))

import { allrWorkClearSession, allrWorkConfig, AllrWorkInvokeError, isAllrWorkSignInInFlight } from '@/lib/allr-work'
import {
  fetchAuthProviders,
  oauthLogin,
  oauthLogout,
  oauthStatus,
  passwordLogin,
  portalAgentSignIn,
  portalLogout
} from '@/lib/auth'
import { clearSecrets, saveSecrets } from '@/lib/secure-store'
import { clearSessionJar, suspendSessionCookiePersistence } from '@/lib/session-persist'
import { $allrWorkError, $allrWorkRestoreIssue } from '@/store/allr-work-state'
import { $gatewayState, connectGateway } from '@/store/gateway'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import { httpRequest } from '@/transport/http'

import {
  $connection,
  $connectionError,
  $connectionPhase,
  beginGatewaySwitch,
  connect,
  connectCloud,
  connectLocal,
  disconnect,
  endGatewaySwitch,
  loadSavedLogin,
  signOut
} from './connection'

const mockHttp = vi.mocked(httpRequest)
const mockProviders = vi.mocked(fetchAuthProviders)
const mockOauthLogin = vi.mocked(oauthLogin)
const mockOauthStatus = vi.mocked(oauthStatus)
const mockPasswordLogin = vi.mocked(passwordLogin)

const status = (body: object) => mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify(body) })
const passwordProvider = { name: 'basic', display_name: 'Basic', supports_password: true }
const oauthProvider = { name: 'nous', display_name: 'Nous', supports_password: false }

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

describe('connect — gated auth path selection', () => {
  it('password-capable provider + creds → ticket via passwordLogin', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([passwordProvider])

    await connect({ url: 'host:1', username: 'admin', password: 'pw' })

    expect(mockPasswordLogin).toHaveBeenCalledWith('http://host:1', 'admin', 'pw', 'basic')
    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'ticket' })
  })

  it('oauth-only provider → interactive oauthLogin, no passwordLogin', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])

    await connect({ url: 'gw.example.com', allowInteractive: true })

    expect(mockOauthStatus).toHaveBeenCalledWith('http://gw.example.com')
    expect(mockOauthLogin).toHaveBeenCalledWith('http://gw.example.com', 'nous')
    expect(mockPasswordLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'oauth' })
  })

  it('oauth with a still-live session → skips the interactive sign-in', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])
    mockOauthStatus.mockResolvedValue({ signedIn: true, reachable: true })

    // No `allowInteractive`: a live session must connect without one, which is
    // what makes the default-false safe for the boot restore.
    await connect({ url: 'gw.example.com' })

    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ authMode: 'oauth' })
  })

  // The bug the user hit: a signed-out restore drove an interactive sign-in that
  // navigated the app's only webview away, three callers deep.
  it('signed out + not user-driven → refuses to open a login page', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])
    mockOauthStatus.mockResolvedValue({ signedIn: false, reachable: true })

    await expect(connect({ url: 'gw.example.com' })).rejects.toMatchObject({
      needsInteractiveSignIn: true
    })

    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect($connection.get()).toBeNull()
  })

  // An unreachable gateway says nothing about the credential. It must surface as a
  // network fault (retryable) and never as "sign in again".
  it('unreachable gateway → a network error, not a sign-in prompt', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])
    mockOauthStatus.mockResolvedValue({ signedIn: false, reachable: false, error: 'host is down' })

    const err = await connect({ url: 'gw.example.com' }).catch(e => e)

    expect(err.needsInteractiveSignIn).toBeUndefined()
    expect(String(err)).toContain('host is down')
    expect(mockOauthLogin).not.toHaveBeenCalled()
  })

  it('ungated backend with a token → token mode', async () => {
    status({ auth_required: false })

    await connect({ url: 'host:2', token: 'TOK' })

    expect(mockProviders).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'token', token: 'TOK' })
  })
})

describe('connectLocal — desktop local spawn', () => {
  it('spawns a backend and connects in token mode', async () => {
    vi.mocked(spawnLocalBackend).mockResolvedValue({
      baseUrl: 'http://127.0.0.1:5051',
      token: 'LT',
      wsUrl: 'ws://127.0.0.1:5051/api/ws?token=LT'
    })

    await connectLocal()

    expect(spawnLocalBackend).toHaveBeenCalled()
    expect(vi.mocked(connectGateway)).toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'local', authMode: 'token', token: 'LT' })
  })

  it('stops the child if the spawn/connect fails', async () => {
    vi.mocked(spawnLocalBackend).mockRejectedValue(new Error('hermes not found'))
    await expect(connectLocal()).rejects.toThrow('hermes not found')
    expect(stopLocalBackend).toHaveBeenCalled()
  })

  it('disconnect stops the local child when in local mode', async () => {
    vi.mocked(spawnLocalBackend).mockResolvedValue({ baseUrl: 'http://127.0.0.1:5051', token: 'LT', wsUrl: 'ws://x' })
    await connectLocal()
    vi.mocked(stopLocalBackend).mockClear()
    disconnect()
    expect(stopLocalBackend).toHaveBeenCalled()
  })
})

describe('signOut', () => {
  it('remote oauth: revokes the gateway cookie, forgets secrets, disconnects', async () => {
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })
    await signOut()
    expect(oauthLogout).toHaveBeenCalledWith('https://gw')
    expect(portalLogout).not.toHaveBeenCalled()
    expect(clearSecrets).toHaveBeenCalled()
    expect($connection.get()).toBeNull()
  })

  it('cloud: also clears the portal session', async () => {
    $connection.set({ baseUrl: 'https://a1', mode: 'cloud', authMode: 'oauth' })
    await signOut()
    expect(oauthLogout).toHaveBeenCalledWith('https://a1')
    expect(portalLogout).toHaveBeenCalled()
  })
})

describe('connectCloud — reauth', () => {
  it('retries via silent SSO when the agent session already expired', async () => {
    vi.mocked(connectGateway).mockRejectedValueOnce({ needsOauthLogin: true }).mockResolvedValueOnce(undefined)
    await connectCloud('https://a1')
    expect(portalAgentSignIn).toHaveBeenCalledWith('https://a1')
    expect(connectGateway).toHaveBeenCalledTimes(2)
    expect($connection.get()).toMatchObject({ mode: 'cloud' })
  })
})

describe('auto-reconnect', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    disconnect()
    $gatewayState.set('idle')
    vi.useRealTimers()
  })

  it('re-dials on an unexpected close', async () => {
    await connectCloud('https://gw')
    vi.mocked(connectGateway).mockClear()
    $gatewayState.set('closed')
    await vi.advanceTimersByTimeAsync(1500)
    expect(connectGateway).toHaveBeenCalled()
  })

  it('does not re-dial after an intentional disconnect', async () => {
    await connectCloud('https://gw')
    disconnect()
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })
    vi.mocked(connectGateway).mockClear()
    $gatewayState.set('closed')
    await vi.advanceTimersByTimeAsync(2000)
    expect(connectGateway).not.toHaveBeenCalled()
  })

  // A soft gateway switch closes the socket on purpose and dials the NEW gateway
  // itself; the supervisor must not race it with a re-dial of the old one.
  it('stands down while a soft gateway switch is in flight', async () => {
    await connectCloud('https://gw')
    beginGatewaySwitch()
    vi.mocked(connectGateway).mockClear()
    $gatewayState.set('closed')
    await vi.advanceTimersByTimeAsync(5000)
    expect(connectGateway).not.toHaveBeenCalled()
    endGatewaySwitch()
  })

  it('re-arms once the switch finishes', async () => {
    await connectCloud('https://gw')
    beginGatewaySwitch()
    endGatewaySwitch()
    // The switch's own dial re-arms the supervisor against the new connection.
    await connectCloud('https://gw2')
    vi.mocked(connectGateway).mockClear()
    $gatewayState.set('closed')
    await vi.advanceTimersByTimeAsync(1500)
    expect(connectGateway).toHaveBeenCalled()
  })

  // The schedule is full jitter (lib/reconnect-backoff), so the FIRST retry now
  // lands inside the 300ms base ceiling rather than at the old fixed 1s floor.
  // Pinning Math.random makes the ceiling directly observable.
  it('re-dials on the jittered schedule, not the old fixed 1s ladder', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)

    try {
      await connectCloud('https://gw')
      vi.mocked(connectGateway).mockClear()
      $gatewayState.set('closed')

      // 0.5 * 300ms ceiling = 150ms. The old ladder would still be waiting.
      await vi.advanceTimersByTimeAsync(100)
      expect(connectGateway).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)
      expect(connectGateway).toHaveBeenCalled()
    } finally {
      random.mockRestore()
    }
  })

  // A gateway that never comes back must not be an endless spinner: past the
  // escalation window the loop publishes the failure, which is what reveals the
  // configurator on the connecting screen.
  it('publishes the failure once the loop has been failing for the escalation window', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(1)

    try {
      await connectCloud('https://gw')
      $connectionError.set(null)
      vi.mocked(connectGateway).mockRejectedValue(new Error('gateway is down'))
      $gatewayState.set('closed')

      // Still inside the window: failures stay quiet so a brief blip never
      // throws the user out of the app.
      await vi.advanceTimersByTimeAsync(20_000)
      expect($connectionError.get()).toBeNull()

      await vi.advanceTimersByTimeAsync(45_000)
      expect($connectionError.get()).toBe('gateway is down')
    } finally {
      random.mockRestore()
      vi.mocked(connectGateway).mockReset()
      vi.mocked(connectGateway).mockResolvedValue(undefined)
      // Let the supervisor reach a success and exit; a loop left mid-backoff
      // holds the re-entrancy guard shut for every test after this one.
      await vi.advanceTimersByTimeAsync(30_000)
    }
  })

  it('clears a published failure once a reconnect succeeds', async () => {
    await connectCloud('https://gw')
    $connectionError.set('stale failure')
    $gatewayState.set('closed')
    await vi.advanceTimersByTimeAsync(1000)
    expect($connectionError.get()).toBeNull()
  })
})

describe('connect — secure credential storage', () => {
  it('stores username in localStorage + secrets in the keyring, never plaintext', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([passwordProvider])

    await connect({ url: 'host:1', username: 'admin', password: 'pw' })

    expect(localStorage.getItem('hermes.username')).toBe('admin')
    expect(localStorage.getItem('hermes.url')).toBe('host:1')
    expect(localStorage.getItem('hermes.password')).toBeNull()
    expect(localStorage.getItem('hermes.token')).toBeNull()
    expect(saveSecrets).toHaveBeenCalledWith({ token: undefined, password: 'pw' })
  })

  it('loadSavedLogin returns the keyring secrets', async () => {
    expect(await loadSavedLogin()).toEqual({ token: 'T', password: 'P' })
  })
})

describe('connect — auto-reconnect target (D8)', () => {
  it('remote connect persists the restore target', async () => {
    status({ auth_required: false })
    await connect({ url: 'host:9', token: 'TOK' })
    const saved = JSON.parse(localStorage.getItem('hermes.connection.last') ?? 'null')
    expect(saved).toMatchObject({ mode: 'remote', url: 'host:9' })
  })

  // This used to assert the OPPOSITE — that sign-out kept the target so the next
  // launch would always reconnect. That is the bug: with the credential gone but
  // the target still there, the next boot seeded `$restoring`, painted
  // "Reconnecting", dialled a gateway it could not authenticate to, and opened an
  // interactive sign-in nobody had asked for.
  it('signOut clears the restore target so the next launch does not auto-dial', async () => {
    status({ auth_required: false })
    await connect({ url: 'host:9', token: 'TOK' })
    expect(localStorage.getItem('hermes.connection.last')).not.toBeNull()
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })
    await signOut()
    expect(localStorage.getItem('hermes.connection.last')).toBeNull()
  })

  // The URL and username are the prefill, not credentials. Dropping them would
  // send the user back to an empty box and make them retype a gateway they use
  // every day.
  it('signOut keeps the url + username so the sign-in screen stays prefilled', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([passwordProvider])
    await connect({ url: 'host:1', username: 'admin', password: 'pw' })

    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'ticket' })
    await signOut()

    expect(localStorage.getItem('hermes.url')).toBe('host:1')
    expect(localStorage.getItem('hermes.username')).toBe('admin')
  })

  it('signOut clears a queued mobile resume marker', async () => {
    localStorage.setItem('hermes.oauth.pending', JSON.stringify({ base: 'https://gw' }))
    localStorage.setItem('hermes.portal.pending', '1')

    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })
    await signOut()

    expect(localStorage.getItem('hermes.oauth.pending')).toBeNull()
    expect(localStorage.getItem('hermes.portal.pending')).toBeNull()
  })

  // A password session's cookie lives in the same Rust jar as an OAuth one, so
  // skipping the logout POST for it left the gateway believing the session was
  // still live. Sign-out was cosmetic for every `ticket` connection.
  it('signOut revokes a ticket session, not just an oauth one', async () => {
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'ticket' })
    await signOut()

    expect(oauthLogout).toHaveBeenCalledWith('https://gw')
  })

  // The logout POST needs a network. Signing out offline must not come back
  // signed in, so the jar is emptied locally whatever the POST did.
  it('signOut empties the live cookie jar even when the logout call fails', async () => {
    vi.mocked(oauthLogout).mockRejectedValueOnce(new Error('offline'))
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })

    await signOut()

    expect(clearSessionJar).toHaveBeenCalled()
  })

  // Sign-out is not instantaneous, and `flushSessionCookies()` fires on the very
  // next backgrounding. Without the latch that flush re-exports the jar into the
  // keyring the sign-out just cleared.
  it('signOut suspends cookie persistence so a later flush cannot resurrect it', async () => {
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })
    await signOut()

    expect(suspendSessionCookiePersistence).toHaveBeenCalled()
  })
})

// The mobile sign-in contract. BOTH mobile flows navigate the calling webview away —
// the RFC 8252 one to /auth/native/authorize, the cookie cascade to /auth/login — so
// `oauthLogin` never resolves there and the marker parked before it is the only thing
// that carries the user back through the reload. Getting either direction wrong is
// silent: no marker and a completed sign-in lands on a blank picker; a stale marker
// sends some unrelated later launch down the resume branch.
describe('beginOAuthLogin — the mobile resume marker', () => {
  const PENDING_OAUTH_KEY = 'hermes.oauth.pending'

  // connection.ts reads IS_NATIVE_MOBILE at import time, so the platform has to be
  // decided before the module loads. Same shape as store/cloud.test.ts.
  const loadOn = async (nativeMobile: boolean) => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_NATIVE_MOBILE: nativeMobile }))

    const auth = await import('@/lib/auth')
    const { httpRequest } = await import('@/transport/http')
    const conn = await import('./connection')

    vi.mocked(httpRequest).mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ auth_required: true })
    })
    vi.mocked(auth.fetchAuthProviders).mockResolvedValue([oauthProvider])
    vi.mocked(auth.oauthStatus).mockResolvedValue({ signedIn: false })

    return { auth, conn }
  }

  afterEach(() => {
    vi.doUnmock('@/lib/platform')
    vi.resetModules()
  })

  it('parks the marker BEFORE handing off, since the hand-off destroys this context', async () => {
    const { auth, conn } = await loadOn(true)
    let parkedAtHandoff: null | string = null

    vi.mocked(auth.oauthLogin).mockImplementation(async () => {
      parkedAtHandoff = localStorage.getItem(PENDING_OAUTH_KEY)

      return { busy: false }
    })

    await conn.connect({ url: 'gw.example.com', allowInteractive: true })

    // Written before, not after: on a real device there is no "after".
    expect(parkedAtHandoff).toContain('gw.example.com')
  })

  it('clears the marker when the sign-in rejects, because then we never navigated', async () => {
    const { auth, conn } = await loadOn(true)

    // A rejection can only reach us with the JS context intact — Rust failed before
    // (or instead of) navigating. The parked marker is now garbage.
    vi.mocked(auth.oauthLogin).mockRejectedValue(new Error('could not open a loopback listener'))

    await expect(conn.connect({ url: 'gw.example.com', allowInteractive: true })).rejects.toThrow()
    expect(localStorage.getItem(PENDING_OAUTH_KEY)).toBeNull()
  })

  // The bug behind "I signed in successfully and was never taken back into the app".
  //
  // Losing the sign-in race used to arrive as a rejection, and the handler above
  // reads a rejection as "we never navigated" and clears the marker. But the
  // WINNER had navigated, and the marker is global — so the loser deleted the
  // winner's. After the round trip the SPA rebooted with nothing to resume.
  it('leaves the winner\'s resume marker alone when it loses the sign-in race', async () => {
    const { auth, conn } = await loadOn(true)

    vi.mocked(auth.oauthLogin).mockResolvedValue({ busy: true })

    await expect(conn.connect({ url: 'gw.example.com', allowInteractive: true })).rejects.toMatchObject({
      signInAlreadyRunning: true
    })

    // Still parked: it is the only thing that finishes the connect after the reload.
    expect(localStorage.getItem(PENDING_OAUTH_KEY)).toContain('gw.example.com')
  })

  it('parks nothing on desktop, where the promise resolves normally', async () => {
    const { auth, conn } = await loadOn(false)

    vi.mocked(auth.oauthLogin).mockResolvedValue({ busy: false })

    await conn.connect({ url: 'gw.example.com', allowInteractive: true })

    expect(localStorage.getItem(PENDING_OAUTH_KEY)).toBeNull()
  })
})

// ── Allr Work (ALLR-51) ───────────────────────────────────────────────────────
//
// Every request to an Allr workspace WITHOUT a bearer is answered by Pomerium, not the
// agent. So the allr path checks the session before it probes anything, and it has no
// sign-in of its own to fall back on: the Allr Work sign-in runs before a connect.
describe('connect — allr', () => {
  const WORKSPACE = 'https://xm.allr.work'

  beforeEach(() => {
    status({ auth_required: true, auth_flows: ['cookie', 'native_pkce'] })
    mockProviders.mockResolvedValue([oauthProvider])
    vi.mocked(connectGateway).mockResolvedValue(undefined)
  })

  it('allr connect calls oauthStatus before /api/status', async () => {
    const order: string[] = []

    mockOauthStatus.mockImplementation(async () => {
      order.push('oauth_status')

      return { signedIn: true, reachable: true, sessionKind: 'native' }
    })
    mockHttp.mockImplementation(async (_method, url) => {
      order.push(String(url))

      return { status: 200, headers: {}, body: JSON.stringify({ auth_required: true }) }
    })

    await connect({ url: WORKSPACE, mode: 'allr' })

    expect(order[0]).toBe('oauth_status')
    expect(order).toContain(`${WORKSPACE}/api/status`)
    expect(mockOauthStatus).toHaveBeenCalledWith(WORKSPACE)
  })

  it('signed-out allr connect throws sign-in-required without invoking oauth_login even when interactive', async () => {
    mockOauthStatus.mockResolvedValue({ signedIn: false, reachable: true })

    await expect(connect({ url: WORKSPACE, mode: 'allr', allowInteractive: true })).rejects.toMatchObject({
      needsInteractiveSignIn: true
    })

    expect(mockOauthLogin).not.toHaveBeenCalled()
    // Nothing unauthenticated went out after the verdict either.
    expect(mockHttp).not.toHaveBeenCalled()
    expect(mockProviders).not.toHaveBeenCalled()
    expect($connection.get()).toBeNull()
    expect($connectionPhase.get()).toBe('error')
  })

  // "Could not tell" — including the 503 an Allr workspace answers an invalid bearer with —
  // must stay retryable, never become "sign in".
  it('an unknown session is a network error for the retry ladder', async () => {
    mockOauthStatus.mockResolvedValue({ signedIn: false, reachable: false, error: 'HTTP 503' })

    const err = await connect({ url: WORKSPACE, mode: 'allr' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toHaveProperty('needsInteractiveSignIn')
    expect((err as Error).message).toBe('HTTP 503')
    expect(mockHttp).not.toHaveBeenCalled()
    expect(mockOauthLogin).not.toHaveBeenCalled()
  })

  it('an oauth_status that throws is unknown too, not signed out', async () => {
    mockOauthStatus.mockRejectedValue(new Error('ipc'))

    await expect(connect({ url: WORKSPACE, mode: 'allr' })).rejects.not.toHaveProperty('needsInteractiveSignIn')
  })

  it('successful allr connect saves mode allr', async () => {
    localStorage.setItem('hermes.url', 'https://my-remote.example.com')
    $allrWorkError.set({ kind: 'timed-out', message: 'old' })
    $allrWorkRestoreIssue.set('unreachable')
    mockOauthStatus.mockResolvedValue({ signedIn: true, reachable: true, sessionKind: 'native' })

    await connect({ url: WORKSPACE, mode: 'allr' })

    expect(JSON.parse(localStorage.getItem('hermes.connection.last') ?? 'null')).toEqual({
      mode: 'allr',
      url: WORKSPACE
    })
    expect($connection.get()).toEqual({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    expect(connectGateway).toHaveBeenCalledWith({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    expect($connectionPhase.get()).toBe('ready')
    // The remote card's prefill and keyring login are not this mode's to overwrite.
    expect(localStorage.getItem('hermes.url')).toBe('https://my-remote.example.com')
    expect(saveSecrets).not.toHaveBeenCalled()
    expect(mockOauthLogin).not.toHaveBeenCalled()
    // A landed connect is the end of whatever the card was warning about.
    expect($allrWorkError.get()).toBeNull()
    expect($allrWorkRestoreIssue.get()).toBeNull()
  })

  it('leaves the remote path untouched when mode is omitted', async () => {
    mockOauthStatus.mockResolvedValue({ signedIn: true, reachable: true })

    await connect({ url: 'gw.example.com' })

    expect(mockHttp.mock.invocationCallOrder[0]).toBeLessThan(mockOauthStatus.mock.invocationCallOrder[0])
    expect(JSON.parse(localStorage.getItem('hermes.connection.last') ?? 'null')).toMatchObject({ mode: 'remote' })
  })
})

describe('signOut — allr', () => {
  const WORKSPACE = 'https://xm.allr.work'

  it('allr sign-out logs out, clears browser session, clears pending', async () => {
    const order: string[] = []

    vi.mocked(oauthLogout).mockImplementationOnce(async () => void order.push('logout'))
    vi.mocked(allrWorkClearSession).mockImplementationOnce(async () => {
      order.push('clear')

      return { cleared: 2, supported: true }
    })
    localStorage.setItem('hermes.allr.pending', '1')
    $allrWorkError.set({ kind: 'no-workspace', message: 'x' })
    $allrWorkRestoreIssue.set('session-ended')
    $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })

    await signOut()

    expect(order).toEqual(['logout', 'clear'])
    expect(oauthLogout).toHaveBeenCalledWith(WORKSPACE)
    expect(allrWorkClearSession).toHaveBeenCalledWith({ workspace: WORKSPACE })
    expect(localStorage.getItem('hermes.allr.pending')).toBeNull()
    expect(localStorage.getItem('hermes.connection.last')).toBeNull()
    expect($allrWorkError.get()).toBeNull()
    expect($allrWorkRestoreIssue.get()).toBeNull()
    expect($connection.get()).toBeNull()
  })

  it('still signs out when the browser session cannot be cleared', async () => {
    vi.mocked(allrWorkClearSession).mockRejectedValueOnce(new AllrWorkInvokeError('cookie-store-failed', 'x'))
    $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })

    await signOut()

    expect(clearSessionJar).toHaveBeenCalled()
    expect($connection.get()).toBeNull()
  })

  // `allr_work_clear_session` takes no lease: deleting the portal / Dex cookies mid-flow
  // would break the sign-in that is running.
  it('never clears the browser session while a sign-in is in flight', async () => {
    vi.mocked(isAllrWorkSignInInFlight).mockReturnValueOnce(true)
    $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })

    await signOut()

    expect(allrWorkClearSession).not.toHaveBeenCalled()
    expect(oauthLogout).toHaveBeenCalledWith(WORKSPACE)
    expect($connection.get()).toBeNull()
  })

  // After a restore that gave up, `$connection` is null — but the keyring bearer and the
  // portal / Pomerium / Dex cookies are all still there. Sign out from that state must still
  // revoke and forget them.
  it('sign out after a failed restore still revokes and clears the saved workspace', async () => {
    localStorage.setItem('hermes.connection.last', JSON.stringify({ mode: 'allr', url: WORKSPACE }))
    localStorage.setItem('hermes.allr.pending', '1')

    await signOut()

    expect(oauthLogout).toHaveBeenCalledWith(WORKSPACE)
    expect(allrWorkClearSession).toHaveBeenCalledWith({ workspace: WORKSPACE })
    expect(localStorage.getItem('hermes.connection.last')).toBeNull()
    expect(localStorage.getItem('hermes.allr.pending')).toBeNull()
  })

  it('sign out with an invalid saved workspace still clears the parent-domain cookies', async () => {
    localStorage.setItem('hermes.connection.last', JSON.stringify({ mode: 'allr', url: 'https://auth.allr.work' }))

    await signOut()

    expect(oauthLogout).not.toHaveBeenCalled()
    expect(allrWorkClearSession).toHaveBeenCalledWith({ workspace: null })
  })

  it('sign out fails closed when the portal config cannot be read', async () => {
    localStorage.setItem('hermes.connection.last', JSON.stringify({ mode: 'allr', url: WORKSPACE }))
    vi.mocked(allrWorkConfig).mockRejectedValueOnce(new AllrWorkInvokeError('invalid-portal-config', 'Bad.'))

    await signOut()

    expect(oauthLogout).not.toHaveBeenCalled()
    expect(allrWorkClearSession).toHaveBeenCalledWith({ workspace: null })
  })

  it('a live non-allr connection never reaches for a saved allr target', async () => {
    localStorage.setItem('hermes.connection.last', JSON.stringify({ mode: 'allr', url: WORKSPACE }))
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })

    await signOut()

    expect(oauthLogout).toHaveBeenCalledOnce()
    expect(oauthLogout).toHaveBeenCalledWith('https://gw')
    expect(allrWorkClearSession).not.toHaveBeenCalled()
  })

  it('does not touch the Allr Work browser session for other modes', async () => {
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })

    await signOut()

    expect(allrWorkClearSession).not.toHaveBeenCalled()
  })
})
