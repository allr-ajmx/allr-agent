import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/connection', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $connection: atom<unknown>(null),
    beginGatewaySwitch: vi.fn(),
    endGatewaySwitch: vi.fn(),
    // Present so a regression that reintroduces the hard reset is caught below.
    disconnect: vi.fn()
  }
})
vi.mock('@/store/gateway', () => ({ closeGateway: vi.fn() }))
vi.mock('@/store/local-backend', () => ({ stopLocalBackend: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/chat', () => ({ resetChat: vi.fn() }))
vi.mock('@/store/cron', () => ({ setCronJobs: vi.fn() }))
vi.mock('@/store/workspace-events', () => ({ resetWorkspaceCwd: vi.fn() }))
vi.mock('@/store/session-states', () => ({ clearAllSessionStates: vi.fn(), resetTileRuntimeBindings: vi.fn() }))
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/store/session', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $activeStoredSessionId: atom<null | string>(null),
    $messagingSessions: atom<unknown[]>([]),
    $sessions: atom<unknown[]>([]),
    $sessionSearch: atom<unknown[]>([]),
    $sessionsLoading: atom(false),
    $sessionsTotal: atom(0),
    $unreadFinishedSessionIds: atom<string[]>([]),
    refreshMessagingSessions: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    resetSessionsPaging: vi.fn()
  }
})

import { $connection, beginGatewaySwitch, disconnect, endGatewaySwitch } from '@/store/connection'
import { closeGateway } from '@/store/gateway'
import type { Connection } from '@/store/gateway-config'
import { stopLocalBackend } from '@/store/local-backend'
import {
  $activeStoredSessionId,
  $messagingSessions,
  $sessions,
  $sessionsLoading,
  $sessionsTotal,
  $unreadFinishedSessionIds,
  refreshMessagingSessions,
  refreshSessions
} from '@/store/session'
import { clearAllSessionStates } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

import { softSwitchGateway } from './gateway-soft-switch'
import { $gatewayMode, $gatewaySwitching } from './gateway-switch'

// Only the fields the wipe / switch actually read.
const session = { id: 's1' } as unknown as SessionInfo

const connectionOn = (mode: 'cloud' | 'local' | 'remote'): Connection =>
  ({ authMode: 'none', baseUrl: 'http://gateway.test', mode }) as Connection

beforeEach(() => {
  localStorage.clear()
  $gatewayMode.set('remote')
  $gatewaySwitching.set(false)
  $connection.set(null)
  $sessions.set([session])
  $sessionsTotal.set(7)
  $messagingSessions.set([session])
  $unreadFinishedSessionIds.set(['s1'])
  $activeStoredSessionId.set('s1')
  $sessionsLoading.set(false)
})
afterEach(() => vi.clearAllMocks())

describe('gateway soft switch', () => {
  it('commits the target mode and never hard-disconnects', async () => {
    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect($gatewayMode.get()).toBe('cloud')
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('wipes gateway-bound session state before dialling', async () => {
    let wipedDuringDial = false

    await softSwitchGateway('remote', async () => {
      wipedDuringDial =
        $sessions.get().length === 0 &&
        $sessionsTotal.get() === 0 &&
        $messagingSessions.get().length === 0 &&
        $unreadFinishedSessionIds.get().length === 0 &&
        $activeStoredSessionId.get() === null &&
        $sessionsLoading.get()
    })

    expect(wipedDuringDial).toBe(true)
    expect(clearAllSessionStates).toHaveBeenCalledOnce()
    // Skeletons stop once the refresh has landed.
    expect($sessionsLoading.get()).toBe(false)
  })

  it('holds $gatewaySwitching for the length of the dial', async () => {
    let switchingDuringDial = false

    await softSwitchGateway('remote', async () => {
      switchingDuringDial = $gatewaySwitching.get()
    })

    expect(switchingDuringDial).toBe(true)
    expect($gatewaySwitching.get()).toBe(false)
  })

  it('suspends the reconnect supervisor across the switch', async () => {
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(beginGatewaySwitch).toHaveBeenCalledOnce()
    expect(endGatewaySwitch).toHaveBeenCalledOnce()
    expect(vi.mocked(beginGatewaySwitch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(endGatewaySwitch).mock.invocationCallOrder[0]
    )
  })

  it('closes the socket before dialling', async () => {
    const dial = vi.fn().mockResolvedValue(undefined)
    await softSwitchGateway('remote', dial)

    expect(vi.mocked(closeGateway).mock.invocationCallOrder[0]).toBeLessThan(dial.mock.invocationCallOrder[0])
  })

  it('stops a local-spawned backend before closing the socket', async () => {
    $connection.set(connectionOn('local'))
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(stopLocalBackend).toHaveBeenCalledOnce()
    expect(vi.mocked(stopLocalBackend).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(closeGateway).mock.invocationCallOrder[0]
    )
  })

  it('leaves a remote backend alone', async () => {
    $connection.set(connectionOn('remote'))
    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(stopLocalBackend).not.toHaveBeenCalled()
  })

  it('refreshes the session lists off the new gateway', async () => {
    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(refreshSessions).toHaveBeenCalledOnce()
    expect(refreshMessagingSessions).toHaveBeenCalledOnce()
  })

  it('re-throws a failed dial and still stands the guards down', async () => {
    await expect(softSwitchGateway('remote', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')

    expect($gatewaySwitching.get()).toBe(false)
    expect($sessionsLoading.get()).toBe(false)
    expect(endGatewaySwitch).toHaveBeenCalledOnce()
    expect(refreshSessions).not.toHaveBeenCalled()
  })
})
