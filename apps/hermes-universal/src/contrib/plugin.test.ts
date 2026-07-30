import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/plugin-transport', () => ({ pluginSocket: vi.fn(() => () => {}) }))

import { pluginSocket } from '@/lib/plugin-transport'

import { createPluginContext } from './plugin'
import { registry } from './registry'

afterEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('createPluginContext', () => {
  it('namespaces the contribution id and stamps provenance', () => {
    const ctx = createPluginContext('kanban')
    const dispose = ctx.register({ area: 'panes', id: 'board', render: () => null })

    const [contribution] = registry.getArea('panes').filter(c => c.source === 'plugin:kanban')

    expect(ctx.source).toBe('plugin:kanban')
    expect(contribution.id).toBe('kanban:board')
    expect(contribution.source).toBe('plugin:kanban')

    dispose()
  })

  it('cannot forge provenance or escape its id namespace', () => {
    const ctx = createPluginContext('evil')

    // A plugin author writing these fields is a type error; a runtime-loaded
    // plugin compiled elsewhere can still pass them, so the host must overwrite.
    const dispose = ctx.register({
      area: 'panes',
      id: 'x',
      render: () => null,
      ...({ source: 'core' } as object)
    })

    const [contribution] = registry.getArea('panes').filter(c => c.id === 'evil:x')

    expect(contribution.source).toBe('plugin:evil')

    dispose()
  })

  it('registerMany returns one disposer that removes all of them', () => {
    const ctx = createPluginContext('multi')

    const dispose = ctx.registerMany([
      { area: 'panes', id: 'a', render: () => null },
      { area: 'panes', id: 'b', render: () => null }
    ])

    expect(registry.getArea('panes').filter(c => c.source === 'plugin:multi')).toHaveLength(2)

    dispose()

    expect(registry.getArea('panes').filter(c => c.source === 'plugin:multi')).toHaveLength(0)
  })

  it('routes every disposer through onDispose — the loader unload hook', () => {
    const collected: Array<() => void> = []
    const ctx = createPluginContext('tracked', dispose => collected.push(dispose))

    ctx.register({ area: 'panes', id: 'a', render: () => null })
    ctx.registerMany([{ area: 'panes', id: 'b', render: () => null }])
    ctx.socket('/events', () => {})
    ctx.i18n.register({ en: { hi: 'hi' } })

    // register + registerMany + socket + i18n.register = 4.
    expect(collected).toHaveLength(4)

    for (const dispose of collected) {
      dispose()
    }

    expect(registry.getArea('panes').filter(c => c.source === 'plugin:tracked')).toHaveLength(0)
  })

  it('scopes storage under hermes.plugin.<id>. so plugins cannot read each other', () => {
    const a = createPluginContext('a')
    const b = createPluginContext('b')

    a.storage.set('token', 'from-a')
    b.storage.set('token', 'from-b')

    expect(a.storage.get('token', null)).toBe('from-a')
    expect(b.storage.get('token', null)).toBe('from-b')
    expect(localStorage.getItem('hermes.plugin.a.token')).toBe('"from-a"')

    a.storage.remove('token')

    expect(a.storage.get('token', 'gone')).toBe('gone')
    // b is untouched by a's removal.
    expect(b.storage.get('token', null)).toBe('from-b')
  })

  it('falls back on malformed stored JSON instead of throwing', () => {
    localStorage.setItem('hermes.plugin.c.broken', '{not json')

    expect(createPluginContext('c').storage.get('broken', 'fallback')).toBe('fallback')
  })

  it('round-trips structured values', () => {
    const ctx = createPluginContext('shapes')
    ctx.storage.set('cfg', { items: [1, 2], nested: { on: true } })

    expect(ctx.storage.get('cfg', null)).toEqual({ items: [1, 2], nested: { on: true } })
  })

  it('passes the plugin id into the socket door so the path cannot be spoofed', () => {
    const ctx = createPluginContext('kanban')

    const onMessage = () => {}

    ctx.socket('/events', onMessage)

    expect(pluginSocket).toHaveBeenCalledWith('kanban', '/events', onMessage)
  })
})
