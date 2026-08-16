import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as PlatformModule from '@/lib/platform'

vi.mock('@/lib/plugin-transport', () => ({ pluginSocket: vi.fn(() => () => {}) }))
// Pretend we're inside the Tauri webview — several modules in this graph gate on it.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  IS_TAURI: true
}))
vi.mock('@/lib/external-link', () => ({ tryOpenExternalLink: vi.fn(async () => true) }))
vi.mock('@/lib/reveal-path', () => ({ tryRevealPathInFileManager: vi.fn(async () => true) }))
vi.mock('@/lib/clipboard', () => ({ writeClipboardText: vi.fn(async () => {}) }))
vi.mock('@/store/native-notifications', () => ({ dispatchPluginNativeNotification: vi.fn() }))

import { writeClipboardText } from '@/lib/clipboard'
import { tryOpenExternalLink } from '@/lib/external-link'
import { pluginSocket } from '@/lib/plugin-transport'
import { tryRevealPathInFileManager } from '@/lib/reveal-path'
import { dispatchPluginNativeNotification } from '@/store/native-notifications'

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

describe('ctx.os — the curated OS door', () => {
  it('routes each door to the app capability behind it, attributed to the plugin', async () => {
    const ctx = createPluginContext('kanban')

    ctx.os.notify({ title: 'Board moved', body: 'to Done' })

    expect(dispatchPluginNativeNotification).toHaveBeenCalledWith('kanban', { title: 'Board moved', body: 'to Done' })
    // The app's native `open_external` seam, NOT the opener plugin's JS `openUrl`
    // — that command is ACL-scoped and this app declares no scope, so it refuses
    // every url and `openExternal` could only ever have resolved false.
    await expect(ctx.os.openExternal('https://example.com')).resolves.toBe(true)
    expect(tryOpenExternalLink).toHaveBeenCalledWith('https://example.com')
    await expect(ctx.os.revealPath('/tmp/board.json')).resolves.toBe(true)
    expect(tryRevealPathInFileManager).toHaveBeenCalledWith('/tmp/board.json')
    await expect(ctx.os.writeClipboard('copied')).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('copied')
  })

  it('resolves false instead of throwing when a capability is unavailable', async () => {
    // What Android and a plain-browser dev run look like: the door is there, the
    // platform underneath is not. A plugin must be able to branch, not crash.
    vi.mocked(tryOpenExternalLink).mockResolvedValueOnce(false)
    vi.mocked(tryRevealPathInFileManager).mockResolvedValueOnce(false)
    vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error('clipboard refused'))

    const ctx = createPluginContext('kanban')

    await expect(ctx.os.openExternal('https://example.com')).resolves.toBe(false)
    await expect(ctx.os.revealPath('/tmp/board.json')).resolves.toBe(false)
    await expect(ctx.os.writeClipboard('copied')).resolves.toBe(false)
  })

  it('swallows a notification the host refuses rather than breaking the caller', () => {
    vi.mocked(dispatchPluginNativeNotification).mockImplementationOnce(() => {
      throw new Error('notification host gone')
    })

    expect(() => createPluginContext('kanban').os.notify({ title: 'boom' })).not.toThrow()
  })
})
