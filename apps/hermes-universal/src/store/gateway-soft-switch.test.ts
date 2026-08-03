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
vi.mock('@/store/gateway-restore', () => ({
  dialSavedTarget: vi.fn().mockResolvedValue(undefined),
  loadGatewayTarget: vi.fn().mockReturnValue(null)
}))
vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))
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
import { dialSavedTarget, type GatewayTarget, loadGatewayTarget } from '@/store/gateway-restore'
import { stopLocalBackend } from '@/store/local-backend'
import { notifyError } from '@/store/notifications'
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
  // clearAllMocks only clears calls, not implementations — re-arm the rollback seam
  // so one test's override can't leak into the next.
  vi.mocked(loadGatewayTarget).mockReturnValue(null)
  vi.mocked(dialSavedTarget).mockResolvedValue(undefined)
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

// The wipe and closeGateway() both run BEFORE the dial, so a failure with no recovery
// leaves an emptied list and a dead socket. These pin the recovery down.
describe('gateway soft switch — failed dial', () => {
  const previousTarget = { mode: 'remote', url: 'old.gateway.test' } as GatewayTarget
  const failing = () => Promise.reject(new Error('unreachable'))

  // Connected to something, with a target to go back to.
  function withPrevious(): void {
    $connection.set(connectionOn('remote'))
    vi.mocked(loadGatewayTarget).mockReturnValue(previousTarget)
  }

  it('rolls back onto the gateway it came from, and still re-throws', async () => {
    withPrevious()

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(dialSavedTarget).toHaveBeenCalledWith(previousTarget)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('reports the switch failure with the reason the dial gave', async () => {
    withPrevious()

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(notifyError).toHaveBeenCalledOnce()
    const [cause, title] = vi.mocked(notifyError).mock.calls[0]
    expect((cause as Error).message).toBe('unreachable')
    expect(title).toBe('Failed to switch gateway')
  })

  it('refills the lists it wiped for a switch that never happened', async () => {
    withPrevious()

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(refreshSessions).toHaveBeenCalledOnce()
    expect(refreshMessagingSessions).toHaveBeenCalledOnce()
  })

  // Nothing left to stand on — the root gate reads $hasConnected, which disconnect()
  // clears, so this is the "drop to the connect screen" path.
  it('goes home when the rollback dial fails too', async () => {
    withPrevious()
    vi.mocked(dialSavedTarget).mockRejectedValueOnce(new Error('old one is gone too'))

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(disconnect).toHaveBeenCalledOnce()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('goes home when there was no previous connection at all', async () => {
    // $connection is null from beforeEach — a first-ever connect.
    vi.mocked(loadGatewayTarget).mockReturnValue(previousTarget)

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(dialSavedTarget).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('goes home when there is no saved target to roll back to', async () => {
    $connection.set(connectionOn('remote'))
    vi.mocked(loadGatewayTarget).mockReturnValue(null)

    await expect(softSwitchGateway('cloud', failing)).rejects.toThrow('unreachable')

    expect(dialSavedTarget).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('does not roll back a switch that succeeded', async () => {
    withPrevious()

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(dialSavedTarget).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })
})
