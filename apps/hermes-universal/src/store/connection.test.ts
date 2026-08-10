import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  passwordLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogin: vi.fn().mockResolvedValue(undefined),
  oauthLogout: vi.fn().mockResolvedValue(undefined),
  oauthStatus: vi.fn().mockResolvedValue({ signedIn: false }),
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
  loadSecrets: vi.fn().mockResolvedValue({ token: 'T', password: 'P' }),
  clearSecrets: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/lib/session-persist', () => ({ persistSessionCookies: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/local-backend', () => ({
  spawnLocalBackend: vi.fn(),
  stopLocalBackend: vi.fn().mockResolvedValue(undefined)
}))

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
import { $gatewayState, connectGateway } from '@/store/gateway'
import { spawnLocalBackend, stopLocalBackend } from '@/store/local-backend'
import { httpRequest } from '@/transport/http'

import {
  $connection,
  $connectionError,
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

    await connect({ url: 'gw.example.com' })

    expect(mockOauthStatus).toHaveBeenCalledWith('http://gw.example.com')
    expect(mockOauthLogin).toHaveBeenCalledWith('http://gw.example.com', 'nous')
    expect(mockPasswordLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ mode: 'remote', authMode: 'oauth' })
  })

  it('oauth with a still-live session → skips the interactive sign-in', async () => {
    status({ auth_required: true })
    mockProviders.mockResolvedValue([oauthProvider])
    mockOauthStatus.mockResolvedValue({ signedIn: true })

    await connect({ url: 'gw.example.com' })

    expect(mockOauthLogin).not.toHaveBeenCalled()
    expect($connection.get()).toMatchObject({ authMode: 'oauth' })
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

  it('signOut does NOT clear the restore target (always reconnect on next launch)', async () => {
    status({ auth_required: false })
    await connect({ url: 'host:9', token: 'TOK' })
    expect(localStorage.getItem('hermes.connection.last')).not.toBeNull()
    $connection.set({ baseUrl: 'https://gw', mode: 'remote', authMode: 'oauth' })
    await signOut()
    expect(localStorage.getItem('hermes.connection.last')).not.toBeNull()
  })
})
