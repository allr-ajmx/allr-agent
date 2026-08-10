import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/connection'

const mintWsTicket = vi.fn()
const constructed: string[] = []

vi.mock('@/lib/auth', () => ({ mintWsTicket: (base: string) => mintWsTicket(base) as Promise<string> }))

vi.mock('@/transport/tauri-websocket', () => ({
  TauriWebSocket: class {
    constructor(url: string) {
      constructed.push(url)
    }
    addEventListener() {}
    close() {}
  }
}))

const { pluginSocket } = await import('./plugin-transport')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('pluginSocket auth', () => {
  beforeEach(() => {
    constructed.length = 0
    mintWsTicket.mockReset()
  })

  afterEach(() => $connection.set(null))

  it('uses the static token in token mode', async () => {
    $connection.set({ authMode: 'token', baseUrl: 'http://127.0.0.1:5051', token: 's3cret' })

    const dispose = pluginSocket('kanban', '/events', () => {})
    await flush()
    dispose()

    expect(mintWsTicket).not.toHaveBeenCalled()
    expect(constructed).toEqual(['ws://127.0.0.1:5051/api/plugins/kanban/events?token=s3cret'])
  })

  // The regression: a gated gateway rejects `?token=` outright and only token
  // mode carries a token, so requiring one made this a permanent no-op there.
  it('mints a ws ticket on an oauth gateway instead of giving up', async () => {
    mintWsTicket.mockResolvedValue('tick et')
    $connection.set({ authMode: 'oauth', baseUrl: 'https://gw.example.com' })

    const dispose = pluginSocket('kanban', '/events', () => {})
    await flush()
    dispose()

    expect(mintWsTicket).toHaveBeenCalledWith('https://gw.example.com')
    expect(constructed).toEqual(['wss://gw.example.com/api/plugins/kanban/events?ticket=tick%20et'])
  })

  it('mints a ticket in ticket mode too', async () => {
    mintWsTicket.mockResolvedValue('t1')
    $connection.set({ authMode: 'ticket', baseUrl: 'http://gw.local' })

    const dispose = pluginSocket('kanban', '/events', () => {})
    await flush()
    dispose()

    expect(constructed).toEqual(['ws://gw.local/api/plugins/kanban/events?ticket=t1'])
  })

  it('sends no credential to an ungated gateway', async () => {
    $connection.set({ authMode: 'none', baseUrl: 'http://gw.local' })

    const dispose = pluginSocket('kanban', '/events', () => {})
    await flush()
    dispose()

    expect(constructed).toEqual(['ws://gw.local/api/plugins/kanban/events'])
  })

  it('joins with & when the path already carries a query', async () => {
    $connection.set({ authMode: 'token', baseUrl: 'http://gw.local', token: 't' })

    const dispose = pluginSocket('kanban', '/events?since=7', () => {})
    await flush()
    dispose()

    expect(constructed).toEqual(['ws://gw.local/api/plugins/kanban/events?since=7&token=t'])
  })

  it('opens nothing when the ticket mint fails', async () => {
    mintWsTicket.mockRejectedValue(new Error('Session expired'))
    $connection.set({ authMode: 'oauth', baseUrl: 'https://gw.example.com' })

    const dispose = pluginSocket('kanban', '/events', () => {})
    await flush()
    dispose()

    expect(constructed).toEqual([])
  })
})
