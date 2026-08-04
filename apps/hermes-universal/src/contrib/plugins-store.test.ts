import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $pluginDecisions,
  $pluginRecords,
  dropPlugin,
  patchPlugin,
  pluginActive,
  publishPlugin,
  setPluginEnabled
} from './plugins-store'

const DECISIONS_KEY = 'hermes.desktop.pluginDecisions.v2'
const LEGACY_DISABLED_KEY = 'hermes.desktop.disabledPlugins.v1'

const record = (id: string, over: Partial<Parameters<typeof publishPlugin>[0]> = {}) =>
  ({ id, kind: 'disk' as const, name: id, status: 'loaded' as const, ...over })

beforeEach(() => {
  $pluginRecords.set({})
  $pluginDecisions.set({})
  localStorage.clear()
})

afterEach(() => vi.clearAllMocks())

describe('pluginActive', () => {
  // The v1 store was a disabled-SET, so absence meant enabled and an opt-in
  // plugin was impossible. v2 keeps explicit choices, so absence defers.
  it('defers to the plugin default when the user has made no choice', () => {
    expect(pluginActive('unknown')).toBe(true)
    expect(pluginActive('unknown', false)).toBe(false)
  })

  it('honours an explicit choice over the default, in both directions', () => {
    $pluginDecisions.set({ off: false, on: true })

    expect(pluginActive('off', true)).toBe(false)
    expect(pluginActive('on', false)).toBe(true)
  })
})

describe('decision persistence', () => {
  it('writes the decision map to localStorage', async () => {
    await setPluginEnabled('kanban', false)

    expect(JSON.parse(localStorage.getItem(DECISIONS_KEY) ?? '{}')).toEqual({ kanban: false })
  })

  it('migrates the v1 disabled-set into explicit falses', async () => {
    localStorage.setItem(LEGACY_DISABLED_KEY, JSON.stringify(['old-a', 'old-b']))
    vi.resetModules()

    const fresh = await import('./plugins-store')

    expect(fresh.$pluginDecisions.get()).toEqual({ 'old-a': false, 'old-b': false })
    expect(fresh.pluginActive('old-a')).toBe(false)
  })

  it('prefers v2 over a stale v1 key', async () => {
    localStorage.setItem(DECISIONS_KEY, JSON.stringify({ kanban: true }))
    localStorage.setItem(LEGACY_DISABLED_KEY, JSON.stringify(['kanban']))
    vi.resetModules()

    const fresh = await import('./plugins-store')

    expect(fresh.pluginActive('kanban')).toBe(true)
  })

  it('survives corrupt stored JSON', async () => {
    localStorage.setItem(DECISIONS_KEY, '{not json')
    vi.resetModules()

    const fresh = await import('./plugins-store')

    expect(fresh.$pluginDecisions.get()).toEqual({})
  })
})

describe('inventory', () => {
  it('publishes and patches a record', () => {
    publishPlugin(record('kanban'))
    patchPlugin('kanban', { error: 'boom', status: 'error' })

    expect($pluginRecords.get().kanban).toMatchObject({ error: 'boom', status: 'error' })
  })

  it('ignores a patch for an unknown id instead of inventing a partial record', () => {
    patchPlugin('ghost', { status: 'error' })

    expect($pluginRecords.get()).toEqual({})
  })

  it('drops a record and its handles', async () => {
    const deactivate = vi.fn()
    publishPlugin(record('kanban'), { activate: vi.fn(), deactivate })

    dropPlugin('kanban')

    expect($pluginRecords.get()).toEqual({})

    // The handle went with it: toggling a dropped plugin is a no-op, not a crash.
    await setPluginEnabled('kanban', false)
    expect(deactivate).not.toHaveBeenCalled()
  })
})

describe('setPluginEnabled', () => {
  it('deactivates live and marks the record disabled', async () => {
    const deactivate = vi.fn()
    publishPlugin(record('kanban'), { activate: vi.fn(), deactivate })

    await setPluginEnabled('kanban', false)

    expect(deactivate).toHaveBeenCalledOnce()
    expect($pluginRecords.get().kanban.status).toBe('disabled')
  })

  it('reactivates live, awaiting an async activate', async () => {
    const order: string[] = []

    const activate = vi.fn(async () => {
      await Promise.resolve()
      order.push('activated')
    })

    publishPlugin(record('kanban', { status: 'disabled' }), { activate, deactivate: vi.fn() })

    await setPluginEnabled('kanban', true)
    order.push('returned')

    expect(order).toEqual(['activated', 'returned'])
  })

  it('records the decision even when no handle exists yet', async () => {
    await setPluginEnabled('not-loaded-yet', false)

    expect(pluginActive('not-loaded-yet')).toBe(false)
  })
})
