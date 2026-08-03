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

import { connect, connectCloud, connectLocal, connectSsh } from '@/store/connection'

import {
  $restoring,
  autoRestoreConnection,
  clearGatewayTarget,
  loadGatewayTarget,
  saveGatewayTarget
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
})
