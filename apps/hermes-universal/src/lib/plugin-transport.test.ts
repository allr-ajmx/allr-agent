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

// The token-mode URL shape, the `&` join, the oauth mint and a failed mint are
// covered by plugin-doors.test.ts alongside the rest of the door contract; this
// file carries the cases that file does not.
describe('pluginSocket auth', () => {
  beforeEach(() => {
    constructed.length = 0
    mintWsTicket.mockReset()
  })

  afterEach(() => $connection.set(null))

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

})
