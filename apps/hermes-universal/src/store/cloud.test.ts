import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/store/connection', () => ({ connectCloud: vi.fn().mockResolvedValue(undefined) }))

import { invoke } from '@tauri-apps/api/core'

import { connectCloud } from '@/store/connection'

import {
  $cloudAgents,
  $cloudConnectingId,
  $cloudError,
  $cloudOrgs,
  $portalResume,
  $portalSignedIn,
  connectCloudAgent,
  discoverCloud,
  refreshCloud,
  resumePortalSignIn
} from './cloud'

/** The one-shot marker `cloudSignIn` parks before the Android round-trip. */
const PENDING_PORTAL_KEY = 'hermes.portal.pending'

const mockInvoke = vi.mocked(invoke)
type Impl = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
const setImpl = (fn: Impl) => mockInvoke.mockImplementation(fn as never)

const agent = {
  id: 'a1',
  name: 'Agent One',
  status: 'running',
  dashboardUrl: 'https://a1.example.com',
  dashboardGatewayState: 'active'
}

beforeEach(() => {
  localStorage.clear()
  mockInvoke.mockReset()
  vi.mocked(connectCloud).mockClear()
  $cloudAgents.set([])
  $cloudOrgs.set([])
  $portalSignedIn.set(false)
  $cloudConnectingId.set(null)
  $cloudError.set(null)
  $portalResume.set(false)
})

describe('cloud discovery', () => {
  it('happy path populates the agent list', async () => {
    setImpl(() =>
      Promise.resolve({ agents: [agent], org: null, orgs: [], needsLogin: false, needsOrgSelection: false })
    )
    await discoverCloud()
    expect($cloudAgents.get()).toHaveLength(1)
    expect($cloudAgents.get()[0].name).toBe('Agent One')
  })

  it('needsLogin clears the signed-in flag', async () => {
    $portalSignedIn.set(true)
    setImpl(() => Promise.resolve({ agents: [], orgs: [], needsLogin: true, needsOrgSelection: false }))
    await discoverCloud()
    expect($portalSignedIn.get()).toBe(false)
  })

  it('needsOrgSelection surfaces the org list', async () => {
    const orgs = [{ id: 'o1', slug: null, name: 'Org', isPersonal: false, role: 'MEMBER' }]
    setImpl(() => Promise.resolve({ agents: [], orgs, needsLogin: false, needsOrgSelection: true }))
    await discoverCloud()
    expect($cloudOrgs.get()).toEqual(orgs)
  })
})

describe('refreshCloud', () => {
  it('discovers when the portal session is live', async () => {
    setImpl(cmd => {
      if (cmd === 'portal_status') {
        return Promise.resolve({ signedIn: true, portalBaseUrl: 'https://portal' })
      }

      return Promise.resolve({ agents: [agent], orgs: [], needsLogin: false, needsOrgSelection: false })
    })
    await refreshCloud()
    expect($portalSignedIn.get()).toBe(true)
    expect($cloudAgents.get()).toHaveLength(1)
  })
})

// The other half of the round-trip. On both phones `portal_login` navigates the calling
// webview to the portal and back, which destroys this JS context — so the promise never
// resolves and the marker parked BEFORE the invoke is the only thing that carries the
// user back to the Cloud card. iOS used to take the desktop path — a 520x720 window that
// tao rendered as a partial overlay — so this gate was `IS_ANDROID` and iOS parked no
// marker. Now both phones navigate away, and both must park one.
describe('cloudSignIn parks the resume marker', () => {
  // The module reads IS_NATIVE_MOBILE at import time, so the platform has to be decided
  // before `./cloud` is loaded. Same shape as lib/artifact-frame.test.ts.
  const loadOn = async (nativeMobile: boolean) => {
    vi.resetModules()
    vi.doMock('@/lib/platform', () => ({ IS_NATIVE_MOBILE: nativeMobile }))

    return import('./cloud')
  }

  const signedIn = (cmd: string) =>
    cmd === 'portal_login'
      ? Promise.resolve({ signedIn: true, portalBaseUrl: 'https://portal' })
      : Promise.resolve({ agents: [agent], orgs: [], needsLogin: false, needsOrgSelection: false })

  afterEach(() => {
    vi.doUnmock('@/lib/platform')
    vi.resetModules()
  })

  it('parks it on mobile, where the sign-in never returns', async () => {
    setImpl(signedIn)

    const { cloudSignIn } = await loadOn(true)
    await cloudSignIn()

    expect(localStorage.getItem(PENDING_PORTAL_KEY)).toBe('1')
  })

  // Desktop's promise DOES resolve, so a marker here would survive to the next boot and
  // jump some unrelated later visit to the Cloud card on its own.
  it('does not park it on desktop, where it resolves normally', async () => {
    setImpl(signedIn)

    const { cloudSignIn } = await loadOn(false)
    await cloudSignIn()

    expect(localStorage.getItem(PENDING_PORTAL_KEY)).toBeNull()
  })
})

describe('resumePortalSignIn', () => {
  const livePortal = (cmd: string) =>
    cmd === 'portal_status'
      ? Promise.resolve({ signedIn: true, portalBaseUrl: 'https://portal' })
      : Promise.resolve({ agents: [agent], orgs: [], needsLogin: false, needsOrgSelection: false })

  // The bug this replaced: the marker was consumed by a GatewayConfigurator mount
  // effect, so a sign-in started from the statusbar popover — which the reload
  // closes — left it in localStorage forever. Nothing mounts in this test, which is
  // the whole point: the boot has to clear it on its own.
  it('consumes the marker and loads the agent list with no configurator mounted', async () => {
    localStorage.setItem(PENDING_PORTAL_KEY, '1')
    setImpl(livePortal)

    await resumePortalSignIn()

    expect(localStorage.getItem(PENDING_PORTAL_KEY)).toBeNull()
    expect($portalResume.get()).toBe(true)
    expect($portalSignedIn.get()).toBe(true)
    expect($cloudAgents.get()).toHaveLength(1)
  })

  // A marker that outlived its boot used to make some unrelated later visit to
  // Settings jump to the Cloud card on its own.
  it('is a no-op with no marker, and does not re-fire on the next boot', async () => {
    setImpl(livePortal)
    await resumePortalSignIn()

    expect($portalResume.get()).toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()

    localStorage.setItem(PENDING_PORTAL_KEY, '1')
    await resumePortalSignIn()
    $portalResume.set(false)
    await resumePortalSignIn()

    expect($portalResume.get()).toBe(false)
  })

  // main.tsx calls this without awaiting, ahead of createRoot().render(). The flag
  // has to be set by the synchronous prefix or the first render misses it — an
  // `await` moved above the set would make the Cloud card lose the race.
  it('raises the flag before its first await', () => {
    localStorage.setItem(PENDING_PORTAL_KEY, '1')
    setImpl(() => new Promise(() => undefined))

    void resumePortalSignIn()

    expect($portalResume.get()).toBe(true)
  })
})

describe('connectCloudAgent', () => {
  it('signs in to the agent then connects in cloud mode', async () => {
    setImpl(cmd => {
      if (cmd === 'portal_agent_sign_in') {
        return Promise.resolve({ connected: true, baseUrl: 'https://a1.example.com' })
      }

      return Promise.resolve()
    })
    await connectCloudAgent(agent)
    expect(mockInvoke).toHaveBeenCalledWith('portal_agent_sign_in', { dashboardUrl: 'https://a1.example.com' })
    expect(connectCloud).toHaveBeenCalledWith('https://a1.example.com')
  })

  // Rejecting is the contract: this runs inside softSwitchGateway, which reads a clean
  // return as a successful switch and would skip its rollback.
  it('rejects for an agent without a dashboard URL', async () => {
    await expect(connectCloudAgent({ ...agent, dashboardUrl: null })).rejects.toThrow(/no reachable dashboard/)
    expect(connectCloud).not.toHaveBeenCalled()
  })

  it('rejects when the silent SSO does not connect', async () => {
    setImpl(command =>
      command === 'portal_agent_sign_in'
        ? Promise.resolve({ connected: false, baseUrl: 'https://a1.example.com' })
        : Promise.resolve()
    )

    await expect(connectCloudAgent(agent)).rejects.toThrow()
    expect(connectCloud).not.toHaveBeenCalled()
    expect($cloudError.get()).toBeTruthy()
  })
})
