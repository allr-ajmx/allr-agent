import { atom } from 'nanostores'

import { notifyError } from '@/store/notifications'

/**
 * Feature store for backend (agent) plugins — the native Hermes plugins plus
 * portable Agent Plugins v1 packages the backend discovers on disk. Settings
 * renders this next to the client (renderer) plugin inventory so every plugin
 * the user has is discoverable and toggleable from one page, whatever process
 * it runs in.
 *
 * Backed by the gateway's `plugins.manage` RPC — the same list/toggle
 * primitives `hermes plugins` and the dashboard use, so all surfaces agree on
 * what's installed and what's enabled. Works against every backend topology
 * (local spawn, SSH, URL+token) because it rides the session's own transport.
 *
 * Ported from apps/desktop/src/store/agent-plugins.ts. The one adaptation:
 * universal exposes `requestGateway` as a plain store function rather than
 * desktop's `useGatewayRequest()` hook, so the injected `GatewayRequest` is
 * satisfied by importing it directly instead of pulling it out of a hook.
 */

export interface AgentPluginRow {
  name: string
  /**
   * Canonical registry key (e.g. `image_gen/fal`) — names can collide, so this
   * is what a toggle addresses.
   *
   * OPTIONAL because it is absent on pre-contract-v6 backends. Universal talks
   * to whatever backend the user points it at (cloud portal, SSH, URL+token),
   * so an older gateway than the one we ship is a live case, not a theoretical
   * one. Every read of it must survive `undefined`.
   */
  key?: string
  version: string
  description: string
  /** 'bundled' | 'user' | 'git' | 'project' | 'entrypoint' */
  source: string
  status: 'disabled' | 'enabled' | 'not enabled'
  /** Agent Plugins v1 package (portable skills/MCP format) vs native Hermes. */
  portable?: boolean
}

export type AgentPluginsStatus = 'error' | 'idle' | 'loading' | 'ready'

/** The recovering `requestGateway` from `store/gateway`. */
export type GatewayRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

export const $agentPlugins = atom<AgentPluginRow[]>([])
export const $agentPluginsStatus = atom<AgentPluginsStatus>('idle')
export const $agentPluginsError = atom<null | string>(null)
/** Key of the row whose toggle RPC is in flight (disables its switch). */
export const $agentPluginBusy = atom<null | string>(null)

let inflight: null | Promise<void> = null

/** Fetch the backend plugin list. Always refetches (it's a cheap local disk
 *  scan on the backend); concurrent callers share one in-flight request. */
export function loadAgentPlugins(request: GatewayRequest): Promise<void> {
  if (inflight) {
    return inflight
  }

  inflight = (async () => {
    if ($agentPluginsStatus.get() !== 'ready') {
      $agentPluginsStatus.set('loading')
    }

    try {
      const result = await request<{ plugins?: AgentPluginRow[] }>('plugins.manage', { action: 'list' })
      $agentPlugins.set(result?.plugins ?? [])
      $agentPluginsStatus.set('ready')
      $agentPluginsError.set(null)
    } catch (e) {
      $agentPluginsError.set(e instanceof Error ? e.message : String(e))
      $agentPluginsStatus.set('error')
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** Flip a backend plugin on/off and patch the row from the RPC's refreshed
 *  copy. Addressed by canonical key ONLY — bare names collide across category
 *  dirs (image_gen/fal vs video_gen/fal), which is exactly why the backend
 *  moved to key-addressed toggles. A keyless row (pre-contract-v6 backend)
 *  therefore renders read-only rather than falling back to the collision-prone
 *  name protocol, so this never gets called without one. Returns whether the
 *  toggle stuck. */
export async function toggleAgentPlugin(
  request: GatewayRequest,
  key: string,
  enable: boolean,
  failMessage: string
): Promise<boolean> {
  $agentPluginBusy.set(key)

  try {
    const result = await request<{ ok?: boolean; plugin?: AgentPluginRow | null }>('plugins.manage', {
      action: 'toggle',
      enable,
      key
    })

    if (!result?.ok) {
      throw new Error(failMessage)
    }

    const refreshed = result.plugin

    if (refreshed) {
      $agentPlugins.set($agentPlugins.get().map(row => (row.key === key ? { ...row, ...refreshed } : row)))
    } else {
      await loadAgentPlugins(request)
    }

    return true
  } catch (e) {
    notifyError(e, failMessage)

    return false
  } finally {
    $agentPluginBusy.set(null)
  }
}

/** Test seam — drop the cached list so a fresh mount refetches. */
export function resetAgentPlugins(): void {
  inflight = null
  $agentPlugins.set([])
  $agentPluginsStatus.set('idle')
  $agentPluginsError.set(null)
  $agentPluginBusy.set(null)
}
