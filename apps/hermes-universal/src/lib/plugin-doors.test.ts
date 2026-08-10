/**
 * The two plugin transport doors. What matters here is the BOUNDARY: `path` is
 * relative to `/api/plugins/<id>` and must not be able to normalize out of that
 * namespace, and the socket must refuse to half-work when it has no credential
 * it may use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const httpRequest = vi.hoisted(() => vi.fn())

const sockets = vi.hoisted(
  () => [] as Array<{ url: string; listeners: Map<string, (e: unknown) => void>; closed: boolean }>
)

vi.mock('@/transport/http', () => ({ getJson: vi.fn(), httpRequest }))

vi.mock('@/transport/tauri-websocket', () => ({
  TauriWebSocket: class {
    closed = false
    listeners = new Map<string, (e: unknown) => void>()

    constructor(public url: string) {
      sockets.push(this)
    }

    addEventListener(type: string, fn: (e: unknown) => void) {
      this.listeners.set(type, fn)
    }

    close() {
      this.closed = true
    }
  }
}))

import { pluginRest, setApiRequestProfile } from '@/hermes'
import { $connection } from '@/store/connection'

import { pluginSocket } from './plugin-transport'

const lastPath = () => String(httpRequest.mock.calls.at(-1)?.[1] ?? '')

beforeEach(() => {
  httpRequest.mockResolvedValue({ body: '{"ok":true}', headers: {}, status: 200 })
  $connection.set({ authMode: 'token', baseUrl: 'http://gw.local', token: 'tok' })
  setApiRequestProfile(null)
  sockets.length = 0
})

afterEach(() => {
  $connection.set(null)
  vi.clearAllMocks()
})

describe('pluginRest', () => {
  it('scopes the call to the plugin namespace', async () => {
    await pluginRest('kanban', '/board')

    expect(lastPath()).toBe('http://gw.local/api/plugins/kanban/board')
  })

  it('accepts a path with no leading slash', async () => {
    await pluginRest('kanban', 'board')

    expect(lastPath()).toBe('http://gw.local/api/plugins/kanban/board')
  })

  it('rejects traversal out of the namespace', async () => {
    for (const path of ['/../other/board', '../other', '/a/../../core', '/..']) {
      await expect(pluginRest('kanban', path)).rejects.toThrow(/illegal path traversal/)
    }

    expect(httpRequest).not.toHaveBeenCalled()
  })

  it('allows `..` inside a query string — only the path portion is the boundary', async () => {
    await pluginRest('kanban', '/search?q=../x')

    expect(lastPath()).toContain('/api/plugins/kanban/search?q=../x')
  })

  it('threads the active profile', async () => {
    setApiRequestProfile('work')
    await pluginRest('kanban', '/board')

    expect(lastPath()).toContain('profile=work')
  })

  it('throws on upload rather than silently dropping the file', async () => {
    await expect(
      pluginRest('kanban', '/import', { upload: { bytes: new ArrayBuffer(4), filename: 'a.csv' } })
    ).rejects.toThrow(/upload is not supported/)

    expect(httpRequest).not.toHaveBeenCalled()
  })

  it('passes method and body through', async () => {
    await pluginRest('kanban', '/board', { body: { title: 'x' }, method: 'POST' })

    const [method, , opts] = httpRequest.mock.calls.at(-1) as [string, string, { body?: unknown }]

    expect(method).toBe('POST')
    expect(opts.body).toEqual({ title: 'x' })
  })
})

describe('pluginSocket', () => {
  it('opens a namespace-scoped ws URL carrying the session token', () => {
    pluginSocket('kanban', '/events', () => {})

    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('ws://gw.local/api/plugins/kanban/events?token=tok')
  })

  it('joins with & when the path already has a query', () => {
    pluginSocket('kanban', '/events?since=1', () => {})

    expect(sockets[0].url).toContain('/events?since=1&token=tok')
  })

  it('rejects traversal before opening anything', () => {
    expect(() => pluginSocket('kanban', '/../other', () => {})).toThrow(/illegal path traversal/)
    expect(sockets).toHaveLength(0)
  })

  // ticket / oauth modes mint a single-use, core-managed ticket per connect that
  // a plugin cannot borrow — no socket beats a half-working one.
  it('no-ops without a usable token instead of opening a doomed socket', () => {
    $connection.set({ authMode: 'oauth', baseUrl: 'http://gw.local' })
    const dispose = pluginSocket('kanban', '/events', () => {})

    expect(sockets).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })

  it('no-ops with no connection at all', () => {
    $connection.set(null)
    pluginSocket('kanban', '/events', () => {})

    expect(sockets).toHaveLength(0)
  })

  it('delivers parsed JSON frames', () => {
    const onMessage = vi.fn()
    pluginSocket('kanban', '/events', onMessage)

    sockets[0].listeners.get('message')?.({ data: '{"type":"moved"}' })

    expect(onMessage).toHaveBeenCalledWith({ type: 'moved' })
  })

  it('skips a non-JSON frame without killing the socket', () => {
    const onMessage = vi.fn()
    pluginSocket('kanban', '/events', onMessage)

    const deliver = sockets[0].listeners.get('message')

    expect(() => deliver?.({ data: 'not json' })).not.toThrow()
    expect(onMessage).not.toHaveBeenCalled()

    deliver?.({ data: '{"ok":1}' })
    expect(onMessage).toHaveBeenCalledWith({ ok: 1 })
  })

  it('reconnects with backoff after a close, and stops once disposed', () => {
    vi.useFakeTimers()

    const dispose = pluginSocket('kanban', '/events', () => {})
    sockets[0].listeners.get('close')?.({})

    vi.advanceTimersByTime(2_000)
    expect(sockets).toHaveLength(2)

    dispose()
    sockets[1].listeners.get('close')?.({})
    vi.advanceTimersByTime(60_000)

    // No third socket: the disposer stops the reconnect loop.
    expect(sockets).toHaveLength(2)

    vi.useRealTimers()
  })

  it('closes the live socket on dispose', () => {
    const dispose = pluginSocket('kanban', '/events', () => {})
    dispose()

    expect(sockets[0].closed).toBe(true)
  })
})
