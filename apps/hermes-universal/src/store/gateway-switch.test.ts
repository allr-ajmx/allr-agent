import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/connection', () => ({ disconnect: vi.fn() }))

import { disconnect } from '@/store/connection'

import { $gatewayMode, $gatewaySwitching, switchGatewayMode } from './gateway-switch'

const mockDisconnect = vi.mocked(disconnect)

beforeEach(() => {
  localStorage.clear()
  $gatewayMode.set('remote')
})
afterEach(() => vi.clearAllMocks())

describe('gateway-switch', () => {
  it('defaults to remote', () => {
    expect($gatewayMode.get()).toBe('remote')
  })

  it('switching drops the live connection and updates the mode', () => {
    switchGatewayMode('cloud')
    expect(mockDisconnect).toHaveBeenCalledOnce()
    expect($gatewayMode.get()).toBe('cloud')
    expect($gatewaySwitching.get()).toBe(false)
  })

  it('is a no-op when already in the target mode', () => {
    switchGatewayMode('remote')
    expect(mockDisconnect).not.toHaveBeenCalled()
    expect($gatewayMode.get()).toBe('remote')
  })

  it('persists the selected mode to localStorage', () => {
    switchGatewayMode('local')
    expect(localStorage.getItem('hermes.gateway.mode')).toBe('local')
  })

  it('persists ssh', () => {
    switchGatewayMode('ssh')
    expect(localStorage.getItem('hermes.gateway.mode')).toBe('ssh')
  })
})

// The codec decodes ONCE, when the atom is created, so reopening the app is the
// only way this path runs. A mode missing from the whitelist does not fail
// loudly — it silently reopens in 'remote' — which is exactly what these check.
describe('persisted-mode whitelist (fresh module, as on app launch)', () => {
  async function reopenWith(stored: string) {
    localStorage.setItem('hermes.gateway.mode', stored)
    vi.resetModules()

    const fresh = await import('./gateway-switch')

    return fresh.$gatewayMode.get()
  }

  it('reopens into ssh', async () => {
    await expect(reopenWith('ssh')).resolves.toBe('ssh')
  })

  it('still reopens into the other known modes', async () => {
    await expect(reopenWith('local')).resolves.toBe('local')
    await expect(reopenWith('cloud')).resolves.toBe('cloud')
  })

  it('degrades an unknown stored mode to remote', async () => {
    await expect(reopenWith('not-a-mode')).resolves.toBe('remote')
  })
})
