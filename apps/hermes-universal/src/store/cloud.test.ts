import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/store/connection', () => ({ connectCloud: vi.fn().mockResolvedValue(undefined) }))

import { invoke } from '@tauri-apps/api/core'

import { connectCloud } from '@/store/connection'

import {
  $cloudAgents,
  $cloudConnectingId,
  $cloudError,
  $cloudOrgs,
  $portalSignedIn,
  connectCloudAgent,
  discoverCloud,
  refreshCloud
} from './cloud'

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
  mockInvoke.mockReset()
  vi.mocked(connectCloud).mockClear()
  $cloudAgents.set([])
  $cloudOrgs.set([])
  $portalSignedIn.set(false)
  $cloudConnectingId.set(null)
  $cloudError.set(null)
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
