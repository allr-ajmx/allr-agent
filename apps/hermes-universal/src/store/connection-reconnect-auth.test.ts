import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Its own file, not another describe in connection.test.ts, and deliberately so. These
// tests decide the platform by `vi.doMock`-ing `@/lib/platform` and re-importing the
// store, and a file that does that in TWO places leaks between them: the loser silently
// gets the real platform, takes the desktop branch, and fails for a reason that has
// nothing to do with the code under test. One registry, one gate.

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  passwordLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogout: vi.fn().mockResolvedValue(undefined),
  oauthStatus: vi.fn().mockResolvedValue({ signedIn: true }),
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
    $gatewayState: atom('idle')
  }
})
vi.mock('@/lib/secure-store', () => ({
  saveSecrets: vi.fn().mockResolvedValue(true),
  loadSecrets: vi.fn().mockResolvedValue(null),
  clearSecrets: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/session-persist', () => ({ persistSessionCookies: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/local-backend', () => ({
  spawnLocalBackend: vi.fn(),
  stopLocalBackend: vi.fn().mockResolvedValue(undefined)
}))

import type * as GatewayStore from '@/store/gateway'

import type * as ConnectionStore from './connection'

const oauthProvider = { name: 'nous', display_name: 'Nous', supports_password: false }

// The reconnect supervisor is a BACKGROUND actor: it wakes on any dropped socket, with no
// user intent behind it. On mobile an interactive sign-in navigates the app's only webview
// away and never returns, so letting the supervisor start one hijacks the whole app at an
// arbitrary moment — and races any sign-in the user starts themselves. Two flows then share
// one webview, the second captures the first's LOGIN PAGE as its "return here" target, and
// whichever finishes last strands the user there. That is a real device failure (two
// `oauth_login` calls 122 ms apart), not a theoretical race.
describe('auto-reconnect — who may drive an interactive sign-in', () => {
  const reauthRequired = () =>
    Object.assign(new Error('Session expired — sign in again'), { needsOauthLogin: true })

  // The store instance the current test is driving, so afterEach can stand its supervisor
  // down. `vi.resetModules()` hands the NEXT test a fresh store but neither stops the
  // previous one's loop nor unsubscribes it — and the mocked `$gatewayState` atom outlives
  // the reset, so an still-armed predecessor would react to the next test's 'closed' too.
  let teardown: null | (() => void) = null

  /**
   * A live connection whose every re-dial is then refused as needing a new session.
   *
   * `dial` picks the mode: remote/oauth is the one-way-door path, cloud is the silent one.
   */
  const arrange = async (nativeMobile: boolean, dial: (conn: typeof ConnectionStore) => Promise<void>) => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_NATIVE_MOBILE: nativeMobile }))

    const auth = await import('@/lib/auth')
    const { httpRequest } = await import('@/transport/http')
    const gateway = await import('@/store/gateway')

    // Back to 'idle' BEFORE the store subscribes, so each test's `set('closed')` is a real
    // transition. That atom is shared across `resetModules`, and re-setting a value it
    // already holds notifies nobody — which is exactly how these tests failed together
    // while passing one at a time.
    gateway.$gatewayState.set('idle')

    const conn = await import('./connection')

    vi.mocked(httpRequest).mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ auth_required: true })
    })
    vi.mocked(auth.fetchAuthProviders).mockResolvedValue([oauthProvider])
    // Already signed in, so the INITIAL dial opens no sign-in of its own and anything we
    // observe afterwards belongs to the supervisor.
    vi.mocked(auth.oauthStatus).mockResolvedValue({ signedIn: true })
    vi.mocked(gateway.connectGateway).mockResolvedValue(undefined)

    await dial(conn)

    vi.mocked(gateway.connectGateway).mockRejectedValue(reauthRequired())
    vi.mocked(auth.oauthLogin).mockClear()
    vi.mocked(auth.portalAgentSignIn).mockClear()

    teardown = () => conn.disconnect()

    return { auth, conn, gateway }
  }

  const remote = (conn: typeof ConnectionStore) => conn.connect({ url: 'gw.example.com' })
  const cloud = (conn: typeof ConnectionStore) => conn.connectCloud('https://gw')

  /** Drop the socket and let the supervisor's first backoff elapse. */
  const dropSocket = async (gateway: typeof GatewayStore) => {
    gateway.$gatewayState.set('closed')
    await vi.advanceTimersByTimeAsync(2_000)
  }

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    teardown?.()
    teardown = null
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('stands down and reports it on mobile, instead of taking over the webview', async () => {
    const { auth, conn, gateway } = await arrange(true, remote)

    await dropSocket(gateway)

    expect(auth.oauthLogin).not.toHaveBeenCalled()
    // Setting this is what reveals the configurator on the connecting screen, so the user
    // can start ONE deliberate, foreground sign-in themselves. Published straight away
    // rather than after RECONNECT_ESCALATE_AFTER_MS (45s): that window exists to let a
    // transient failure resolve itself, and a dead session will not.
    expect(conn.$connectionError.get()).toContain('Session expired')
  })

  it('still re-auths silently on desktop, where the sign-in returns', async () => {
    const { auth, gateway } = await arrange(false, remote)

    await dropSocket(gateway)

    expect(auth.oauthLogin).toHaveBeenCalled()
  })

  // Cloud re-auths through `portalAgentSignIn`, which on mobile is the silent reqwest
  // cascade in cloud.rs::agent_sso — nothing navigates, so the supervisor may drive it, and
  // blocking it would be a pointless regression.
  it('still re-auths a cloud agent on mobile, because that one is silent', async () => {
    const { auth, gateway } = await arrange(true, cloud)

    await dropSocket(gateway)

    expect(auth.portalAgentSignIn).toHaveBeenCalled()
    expect(auth.oauthLogin).not.toHaveBeenCalled()
  })

  // ── the retry budget ─────────────────────────────────────────────────────
  //
  // Auth and network failures get deliberately different policies, and the two
  // tests below are the pair that pins that apart. Collapsing them would be a
  // regression in one direction or the other: capping network retries makes a
  // phone that spent a minute in a lift give up permanently, while NOT capping
  // auth retries leaves a genuinely expired session spinning forever behind a
  // screen with no way out.

  /** Let the ladder run long enough for many jittered attempts (cap is 15s). */
  const runLadder = async () => vi.advanceTimersByTimeAsync(300_000)

  it('stops re-dialling once the auth budget is spent', async () => {
    // Desktop: the mobile branch stands down on the FIRST auth failure for its own
    // reasons, so the budget is only observable where the supervisor is allowed to
    // keep trying.
    const { conn, gateway } = await arrange(false, remote)

    await dropSocket(gateway)
    await runLadder()

    const settled = vi.mocked(gateway.connectGateway).mock.calls.length

    await runLadder()

    // Not merely "few attempts" — no FURTHER attempts. That is the difference
    // between a bounded ladder and a slow one.
    expect(vi.mocked(gateway.connectGateway).mock.calls.length).toBe(settled)
    expect(conn.$connectionError.get()).toContain('Session expired')
  })

  it('keeps re-dialling a network failure past the auth budget', async () => {
    const { gateway } = await arrange(false, remote)

    // A refused connection, not a refused credential. This one really does resolve
    // on its own — a gateway mid-restart, wifi coming back — so the ladder must
    // outlive three attempts.
    vi.mocked(gateway.connectGateway).mockRejectedValue(new Error('Network request failed'))

    await dropSocket(gateway)
    await runLadder()

    const settled = vi.mocked(gateway.connectGateway).mock.calls.length

    expect(settled).toBeGreaterThan(3)

    await runLadder()

    expect(vi.mocked(gateway.connectGateway).mock.calls.length).toBeGreaterThan(settled)
  })

  // The cap ends a spinner; it must not end the session. Coming back to the app is
  // fresh user intent and buys a fresh budget — otherwise a stood-down session
  // would stay dead until the app was relaunched, which is the very failure this
  // whole change exists to remove.
  it('refunds the budget when the user brings the app back', async () => {
    const { conn, gateway } = await arrange(false, remote)

    await dropSocket(gateway)
    await runLadder()

    const settled = vi.mocked(gateway.connectGateway).mock.calls.length

    conn.wakeReconnect()
    await runLadder()

    expect(vi.mocked(gateway.connectGateway).mock.calls.length).toBeGreaterThan(settled)
  })
})
