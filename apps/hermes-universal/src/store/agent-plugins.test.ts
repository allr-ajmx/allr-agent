import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $agentPluginBusy,
  $agentPlugins,
  $agentPluginsError,
  $agentPluginsStatus,
  type AgentPluginRow,
  loadAgentPlugins,
  resetAgentPlugins,
  toggleAgentPlugin
} from './agent-plugins'

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

const row = (over: Partial<AgentPluginRow> = {}): AgentPluginRow => ({
  description: 'Generates images',
  key: 'image_gen/fal',
  name: 'fal',
  source: 'user',
  status: 'enabled',
  version: '1.0.0',
  ...over
})

beforeEach(() => {
  resetAgentPlugins()
})

describe('loadAgentPlugins', () => {
  it('fills the list from plugins.manage', async () => {
    const request = vi.fn().mockResolvedValue({ plugins: [row()] })

    await loadAgentPlugins(request)

    expect(request).toHaveBeenCalledWith('plugins.manage', { action: 'list' })
    expect($agentPlugins.get()).toHaveLength(1)
    expect($agentPluginsStatus.get()).toBe('ready')
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const request = vi.fn().mockResolvedValue({ plugins: [] })

    await Promise.all([loadAgentPlugins(request), loadAgentPlugins(request)])

    expect(request).toHaveBeenCalledTimes(1)
  })

  it('surfaces the failure instead of leaving the list half-loaded', async () => {
    await loadAgentPlugins(vi.fn().mockRejectedValue(new Error('gateway down')))

    expect($agentPluginsStatus.get()).toBe('error')
    expect($agentPluginsError.get()).toBe('gateway down')
  })
})

describe('toggleAgentPlugin', () => {
  it('patches the row from the RPC’s refreshed copy', async () => {
    $agentPlugins.set([row()])
    const request = vi.fn().mockResolvedValue({ ok: true, plugin: row({ status: 'disabled' }) })

    const stuck = await toggleAgentPlugin(request, 'image_gen/fal', false, 'nope')

    expect(stuck).toBe(true)
    expect($agentPlugins.get()[0]?.status).toBe('disabled')
    expect($agentPluginBusy.get()).toBeNull()
  })

  it('reloads the whole list when the RPC returns no refreshed row', async () => {
    $agentPlugins.set([row()])

    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, plugin: null })
      .mockResolvedValueOnce({ plugins: [row({ status: 'disabled' })] })

    await toggleAgentPlugin(request, 'image_gen/fal', false, 'nope')

    expect(request).toHaveBeenNthCalledWith(2, 'plugins.manage', { action: 'list' })
    expect($agentPlugins.get()[0]?.status).toBe('disabled')
  })

  it('reports a rejected toggle rather than showing it as applied', async () => {
    $agentPlugins.set([row()])

    const stuck = await toggleAgentPlugin(vi.fn().mockResolvedValue({ ok: false }), 'image_gen/fal', false, 'nope')

    expect(stuck).toBe(false)
    expect($agentPlugins.get()[0]?.status).toBe('enabled')
    expect($agentPluginBusy.get()).toBeNull()
  })
})
