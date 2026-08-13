import { invoke } from '@tauri-apps/api/core'

import { portalAgentSignIn, portalLogout } from '@/lib/auth'
import { errorText } from '@/lib/error-text'
import { IS_ANDROID } from '@/lib/platform'
import { atom } from '@/store/atom'
import { connectCloud } from '@/store/connection'
import { saveGatewayTarget, savePendingPortal, takePendingPortal } from '@/store/gateway-restore'

// Nous Cloud store (E5). Portal login + agent discovery + connect. The Privy
// portal session + per-agent SSO live in Rust (src-tauri/src/cloud.rs); this holds
// the discovery state and orchestrates the connect.

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

/**
 * Set for this run when the boot followed an Android portal sign-in round-trip, so
 * the next gateway panel to open lands on the Cloud card instead of whatever mode
 * was persisted. Read (and cleared) by GatewayConfigurator.
 *
 * In memory on purpose. The durable half of this is the `hermes.portal.pending`
 * marker, and it is consumed by `resumePortalSignIn` at boot — see there for why
 * the configurator must not be the thing that consumes it.
 */
export const $portalResume = atom(false)

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

/**
 * Finish an Android portal sign-in that came back through a page reload.
 *
 * `cloudSignIn` parks a one-shot marker before handing off to Rust, because the
 * round-trip destroys this JS context (see there). Something has to pick it back up,
 * and that something must be the BOOT — not a component.
 *
 * It used to be a `GatewayConfigurator` mount effect, which holds only when the
 * sign-in was started from a surface the reload rebuilds: Settings, or the connect
 * screen. Started from the statusbar gateway popover the reload closes it, no
 * configurator mounts, and the marker was never read at all — so the user came back
 * to the chat with no Cloud card, no agent list and nothing to show for the login
 * they had just completed, and the marker sat in localStorage until some unrelated
 * later visit to Settings silently jumped to Cloud on the strength of it.
 *
 * Called once from `main.tsx`. Everything up to the first await runs synchronously,
 * so `$portalResume` is already set before the first render reads it.
 */
export async function resumePortalSignIn(): Promise<void> {
  if (!takePendingPortal()) {
    return
  }

  $portalResume.set(true)

  // Populate the card while the user is still finding their way back to it: the
  // portal session is live as of a second ago, so this is the agent list they
  // signed in to see.
  await refreshCloud()
}

/**
 * Interactive portal sign-in, then discover.
 *
 * On ANDROID this may never return: the Rust command navigates the calling webview to the
 * portal and back, which destroys this JS context (same round-trip as the gateway OAuth —
 * see store/connection.ts `beginOAuthLogin`). The marker persisted first is what puts the
 * gateway panel back on the cloud card after the reload.
 */
export async function cloudSignIn(): Promise<void> {
  $cloudError.set(null)

  if (IS_ANDROID) {
    savePendingPortal()
  }

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

/**
 * Silent SSO into the agent's gateway, then connect in cloud/oauth mode.
 *
 * Throws on failure. It is called INSIDE `softSwitchGateway`, which reads a clean return
 * as "the switch worked" — so swallowing here skipped the rollback (leaving the session
 * lists wiped and the socket closed) and then broadcast the *previous* target to every
 * other WebView, re-homing them onto the gateway this one had just left.
 */
export async function connectCloudAgent(agent: CloudAgent): Promise<void> {
  if (!agent.dashboardUrl) {
    const message = 'This agent has no reachable dashboard yet.'
    $cloudError.set(message)

    throw new Error(message)
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

    throw err
  } finally {
    $cloudConnectingId.set(null)
  }
}
