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
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/local-backend', () => ({ stopLocalBackend: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/chat', () => ({ resetChat: vi.fn() }))
vi.mock('@/store/cron', () => ({ setCronJobs: vi.fn() }))
vi.mock('@/store/workspace-events', () => ({ resetWorkspaceCwd: vi.fn() }))
vi.mock('@/store/session-states', () => ({ clearAllSessionStates: vi.fn(), resetTileRuntimeBindings: vi.fn() }))
// Both of these key their caches by the GATEWAY's absolute repo paths. What the
// clearing actually does is asserted in their own suites; here the question is
// whether the wipe calls them at all.
vi.mock('@/store/coding-status', () => ({ resetRepoStatusForBackendSwitch: vi.fn() }))
vi.mock('@/store/pull-requests', () => ({ resetPullRequestsForBackendSwitch: vi.fn() }))
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
// NOT mocked: `@/store/artifacts` runs for real below, because "the wipe drops the
// artifact registry" is only worth asserting against the real registry. It reaches
// the native staging commands through `invoke`, which needs a stub outside Tauri.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
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
    resetSessionsPaging: vi.fn(),
    // The real predicate — the missing-session check is only meaningful if lineage
    // matching behaves as it does in production.
    sessionMatchesStoredId: (session: { _lineage_root_id?: string; id: string }, storedSessionId: string): boolean =>
      session.id === storedSessionId || session._lineage_root_id === storedSessionId
  }
})

import { resetRepoStatusForBackendSwitch } from '@/store/coding-status'
import { $connection, beginGatewaySwitch, disconnect, endGatewaySwitch } from '@/store/connection'
import { closeGateway } from '@/store/gateway'
import type { Connection } from '@/store/gateway-config'
import { dialSavedTarget, type GatewayTarget, loadGatewayTarget } from '@/store/gateway-restore'
import { stopLocalBackend } from '@/store/local-backend'
import { notify, notifyError } from '@/store/notifications'
import { resetPullRequestsForBackendSwitch } from '@/store/pull-requests'
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

import { artifactsForSession, openArtifact, upsertArtifact } from './artifacts'
import { sessionMissingFromCurrentGateway, softSwitchGateway } from './gateway-soft-switch'
import { $gatewayMode, $gatewaySwitching } from './gateway-switch'
import { $activePreviewPath, $previewTabs, setPreviewTarget } from './preview'
import { $dirtyPreviewPaths, setPreviewDirty } from './preview-edit'

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
  vi.mocked(refreshSessions).mockResolvedValue(undefined)
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

  // A repo path is not gateway-scoped: `/home/me/work` exists on the laptop AND
  // on the box being switched to, and they are different repos on different
  // branches. Carried across, the coding rails paint the previous gateway's
  // branch and ± under the new one's paths, and the is-this-a-repo memo (no TTL)
  // keeps answering for a repo that only ever existed over there.
  it('drops the git + PR caches keyed by the old gateway’s paths, before dialling', async () => {
    let clearedDuringDial = false

    await softSwitchGateway('remote', async () => {
      clearedDuringDial =
        vi.mocked(resetRepoStatusForBackendSwitch).mock.calls.length === 1 &&
        vi.mocked(resetPullRequestsForBackendSwitch).mock.calls.length === 1
    })

    expect(clearedDuringDial).toBe(true)
  })

  // Artifacts are keyed by sessions on the gateway that produced them. Carried
  // across a switch, an open artifact tab names an id the new backend has never
  // heard of — and the registry keeps the old backend's generated pages alive
  // for the rest of the process.
  it('drops the artifact registry and its tabs', async () => {
    const artifact = upsertArtifact('s1', { kind: 'html', language: 'html', title: 'Dashboard' }, '<html>v1</html>')!

    openArtifact(artifact.artifactId)

    expect($previewTabs.get()).toHaveLength(1)

    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect(artifactsForSession('s1')).toEqual([])
    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
  })

  // The FILE half of the same problem, and the one the artifact wipe above does
  // NOT cover: a preview tab is an absolute path read and written over
  // `/api/fs/*` on whichever gateway is current, so a tab that survives the
  // switch shows the old backend's bytes over the new backend's path — and its
  // save either recreates a file that only existed over there or overwrites a
  // same-named one here.
  it('closes file preview tabs, which name paths on the old gateway', async () => {
    setPreviewTarget('/srv/project/config.ts')
    setPreviewDirty('/srv/project/config.ts', true)

    expect($previewTabs.get()).toHaveLength(1)

    await softSwitchGateway('remote', vi.fn().mockResolvedValue(undefined))

    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
    expect($dirtyPreviewPaths.get().has('/srv/project/config.ts')).toBe(false)
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

// Sessions are per-backend, so the chat the user was on usually does NOT come across
// a switch. The wipe already drops them onto a fresh session; these cover the part
// that explains why, so it doesn't read as the app losing their conversation.
describe('gateway soft switch — session that did not come across', () => {
  const listed = (id: string) => ({ id }) as unknown as SessionInfo

  it('warns when the session the user was on is absent from the new gateway', async () => {
    $activeStoredSessionId.set('s-old')
    vi.mocked(refreshSessions).mockImplementation(async () => {
      $sessions.set([listed('s-other')])
    })

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).toHaveBeenCalledOnce()
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({
      kind: 'warning',
      title: 'Gateway changed',
      message: "This session doesn't exist on the new gateway."
    })
  })

  it('stays quiet when the session does exist on the new gateway', async () => {
    $activeStoredSessionId.set('s-old')
    vi.mocked(refreshSessions).mockImplementation(async () => {
      $sessions.set([listed('s-old')])
    })

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).not.toHaveBeenCalled()
  })

  it('stays quiet when no session was open to begin with', async () => {
    $activeStoredSessionId.set(null)
    vi.mocked(refreshSessions).mockImplementation(async () => {
      $sessions.set([listed('s-other')])
    })

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).not.toHaveBeenCalled()
  })

  // The rollback path puts the user back where they were, so nothing went missing.
  it('does not warn when the switch failed and rolled back', async () => {
    $activeStoredSessionId.set('s-old')
    $connection.set(connectionOn('remote'))
    vi.mocked(loadGatewayTarget).mockReturnValue({ mode: 'remote', url: 'old' } as GatewayTarget)

    await expect(softSwitchGateway('cloud', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope')

    expect(notify).not.toHaveBeenCalled()
  })

  it('matches a session by its lineage root, not just its live id', () => {
    $sessions.set([{ id: 's-new', _lineage_root_id: 's-old' } as unknown as SessionInfo])

    expect(sessionMissingFromCurrentGateway('s-old')).toBe(false)
    expect(sessionMissingFromCurrentGateway('s-gone')).toBe(true)
  })
})

// A dropped list request leaves $sessions empty, which looks exactly like "the new
// gateway has none" — claiming the user's chat is gone on that basis would be a lie.
describe('gateway soft switch — session check needs a real list', () => {
  it('stays quiet when the session list failed to load', async () => {
    $activeStoredSessionId.set('s-old')
    vi.mocked(refreshSessions).mockRejectedValue(new Error('list request dropped'))

    await softSwitchGateway('cloud', vi.fn().mockResolvedValue(undefined))

    expect(notify).not.toHaveBeenCalled()
  })
})
