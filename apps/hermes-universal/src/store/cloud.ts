import { invoke } from '@tauri-apps/api/core'

import { portalAgentSignIn, portalLogout } from '@/lib/auth'
import { errorText } from '@/lib/error-text'
import { atom } from '@/store/atom'
import { connectCloud } from '@/store/connection'
import { saveGatewayTarget } from '@/store/gateway-restore'

// Nous Cloud store (E5). Portal login + agent discovery + connect. The Privy
// portal session + per-agent SSO live in Rust (src-tauri/src/cloud.rs); this holds
// the discovery state and orchestrates the connect. Desktop-working; on Android
// the portal cookie can't be bridged (FIXME(E4) in cloud.rs) so discovery returns
// needsLogin there.

export interface CloudAgent {
  id: string
  name: string
  status: string
  dashboardUrl?: string | null
  dashboardGatewayState: string
}

export interface CloudOrg {
  id: string
  slug?: string | null
  name: string
  isPersonal: boolean
  role: string
}

interface DiscoverResult {
  agents: CloudAgent[]
  org?: CloudOrg | null
  orgs: CloudOrg[]
  needsLogin: boolean
  needsOrgSelection: boolean
}

interface PortalStatus {
  signedIn: boolean
  portalBaseUrl: string
}

export type CloudDiscover = 'idle' | 'loading' | 'done' | 'error'

export const $portalSignedIn = atom(false)
export const $cloudAgents = atom<CloudAgent[]>([])
export const $cloudOrgs = atom<CloudOrg[]>([])
export const $cloudOrg = atom<CloudOrg | null>(null)
export const $cloudDiscover = atom<CloudDiscover>('idle')
export const $cloudError = atom<string | null>(null)
export const $cloudConnectingId = atom<string | null>(null)

const portalStatus = () => invoke<PortalStatus>('portal_status')
const portalLogin = () => invoke<PortalStatus>('portal_login')

const portalDiscover = (org?: string | null) => invoke<DiscoverResult>('portal_discover_agents', { org: org ?? null })

function applyDiscover(result: DiscoverResult): void {
  if (result.needsLogin) {
    $portalSignedIn.set(false)
    $cloudDiscover.set('idle')

    return
  }

  if (result.needsOrgSelection) {
    $cloudOrgs.set(result.orgs)
    $cloudDiscover.set('done')

    return
  }

  $cloudAgents.set(result.agents)
  $cloudOrg.set(result.org ?? null)

  if (result.org) {
    $cloudOrgs.set([])
  }

  $cloudDiscover.set('done')
}

/** Discover agents for the (optional) org; surfaces needs-login / org-selection. */
export async function discoverCloud(org?: string | null): Promise<void> {
  $cloudError.set(null)
  $cloudDiscover.set('loading')

  try {
    applyDiscover(await portalDiscover(org))
  } catch (err) {
    $cloudError.set(errorText(err))
    $cloudDiscover.set('error')
  }
}

/** On entering cloud mode: check the portal session, then discover if signed in. */
export async function refreshCloud(): Promise<void> {
  $cloudError.set(null)

  try {
    const status = await portalStatus()
    $portalSignedIn.set(status.signedIn)

    if (status.signedIn) {
      await discoverCloud()
    }
  } catch (err) {
    $cloudError.set(errorText(err))
  }
}

/** Interactive portal sign-in, then discover. */
export async function cloudSignIn(): Promise<void> {
  $cloudError.set(null)

  try {
    const status = await portalLogin()
    $portalSignedIn.set(status.signedIn)

    if (status.signedIn) {
      await discoverCloud()
    }
  } catch (err) {
    $cloudError.set(errorText(err))
  }
}

/** Pick a different org (multi-org accounts) and re-discover. */
export async function selectCloudOrg(org: CloudOrg): Promise<void> {
  $cloudOrg.set(org)
  $cloudOrgs.set([])
  await discoverCloud(org.id)
}

/**
 * "Change org": clear the selected org + its agent list and re-discover with no
 * org arg. A multi-org account gets the picker back; a single-org account simply
 * auto-resolves to its one org (harmless). Mirrors desktop's changeCloudOrg.
 */
export async function changeCloudOrg(): Promise<void> {
  $cloudOrg.set(null)
  $cloudAgents.set([])
  await discoverCloud()
}

/** Sign out of the Nous portal and clear all discovery state. */
export async function cloudSignOut(): Promise<void> {
  $cloudError.set(null)

  try {
    await portalLogout()
  } catch (err) {
    $cloudError.set(errorText(err))
  } finally {
    $portalSignedIn.set(false)
    $cloudAgents.set([])
    $cloudOrgs.set([])
    $cloudOrg.set(null)
    $cloudDiscover.set('idle')
  }
}

/** Silent SSO into the agent's gateway, then connect in cloud/oauth mode. */
export async function connectCloudAgent(agent: CloudAgent): Promise<void> {
  if (!agent.dashboardUrl) {
    $cloudError.set('This agent has no reachable dashboard yet.')

    return
  }

  $cloudError.set(null)
  $cloudConnectingId.set(agent.id)

  try {
    const result = await portalAgentSignIn(agent.dashboardUrl)

    if (!result.connected) {
      throw new Error('Could not sign in to this agent')
    }

    await connectCloud(result.baseUrl)
    // Enrich the saved restore target (connectCloud persisted the baseUrl) with the
    // agent id/name so the boot connecting screen can label it (D8).
    saveGatewayTarget({
      mode: 'cloud',
      cloudBaseUrl: result.baseUrl,
      cloudAgentId: agent.id,
      cloudAgentName: agent.name
    })
  } catch (err) {
    $cloudError.set(errorText(err))
  } finally {
    $cloudConnectingId.set(null)
  }
}
