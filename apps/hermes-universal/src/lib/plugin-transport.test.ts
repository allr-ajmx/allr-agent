import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $connection } from '@/store/connection'
import type { Connection } from '@/store/gateway-config'

const mintWsTicket = vi.fn()

interface FakeSocket {
  url: string
  closed: boolean
  listeners: Map<string, (event: unknown) => void>
}

const sockets: FakeSocket[] = []
const constructed = () => sockets.map(socket => socket.url)

vi.mock('@/lib/auth', () => ({ mintWsTicket: (base: string) => mintWsTicket(base) as Promise<string> }))

vi.mock('@/transport/tauri-websocket', () => ({
  TauriWebSocket: class {
    closed = false
    listeners = new Map<string, (event: unknown) => void>()

    constructor(public url: string) {
      sockets.push(this)
    }

    addEventListener(type: string, fn: (event: unknown) => void) {
      this.listeners.set(type, fn)
    }

    close() {
      this.closed = true
    }
  }
}))

const { pluginSocket } = await import('./plugin-transport')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const gateway = (baseUrl: string, authMode: Connection['authMode'] = 'none'): Connection =>
  ({ authMode, baseUrl }) as Connection

const disposers: Array<() => void> = []

const open = (path = '/events', onMessage: (data: unknown) => void = () => {}) => {
  const dispose = pluginSocket('kanban', path, onMessage)

  disposers.push(dispose)

  return dispose
}

beforeEach(() => {
  sockets.length = 0
  mintWsTicket.mockReset()
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  $connection.set(null)
})

// The token-mode URL shape, the `&` join, the oauth mint and a failed mint are
// covered by plugin-doors.test.ts alongside the rest of the door contract; this
// file carries the cases that file does not.
describe('pluginSocket auth', () => {
  it('mints a ticket in ticket mode too', async () => {
    mintWsTicket.mockResolvedValue('t1')
    $connection.set(gateway('http://gw.local', 'ticket'))

    open()
    await flush()

    expect(constructed()).toEqual(['ws://gw.local/api/plugins/kanban/events?ticket=t1'])
  })

  it('sends no credential to an ungated gateway', async () => {
    $connection.set(gateway('http://gw.local'))

    open()
    await flush()

    expect(constructed()).toEqual(['ws://gw.local/api/plugins/kanban/events'])
  })
})

/**
 * MJXHRM-405. The door authenticates in every mode — but that only mattered
 * once it could open at all: plugins register from a module body
 * (`discoverBundledPlugins()` in app/contrib/controller.tsx) and `main.tsx`
 * dials AFTERWARDS, so `$connection` is null at `ctx.socket()` time on every
 * cold boot, and a gateway change is a soft re-home in place, never a reload.
 */
describe('pluginSocket lifecycle', () => {
  it('opens once the app finishes dialling, having been created before it', async () => {
    open()
    await flush()

    expect(sockets).toHaveLength(0)

    $connection.set(gateway('http://gw.local'))
    await flush()

    expect(constructed()).toEqual(['ws://gw.local/api/plugins/kanban/events'])
  })

  it('re-homes onto the new gateway on a soft switch, closing the old socket', async () => {
    $connection.set(gateway('http://old.local'))
    open()
    await flush()

    $connection.set(gateway('http://new.local'))
    await flush()

    expect(sockets[0].closed).toBe(true)
    expect(constructed()).toEqual([
      'ws://old.local/api/plugins/kanban/events',
      'ws://new.local/api/plugins/kanban/events'
    ])
  })

  it('drops the socket on disconnect and opens nothing until a gateway returns', async () => {
    $connection.set(gateway('http://gw.local'))
    open()
    await flush()

    $connection.set(null)
    await flush()

    expect(sockets[0].closed).toBe(true)
    expect(sockets).toHaveLength(1)

    $connection.set(gateway('http://gw.local'))
    await flush()

    expect(sockets).toHaveLength(2)
  })

  it('stops following the connection once disposed', async () => {
    $connection.set(gateway('http://gw.local'))
    const dispose = open()
    await flush()
    dispose()

    $connection.set(gateway('http://other.local'))
    await flush()

    expect(sockets).toHaveLength(1)
  })

  // A frame is not the signal — a plugin stream can be silent for hours (the
  // kanban sample's `/events` says nothing until a task moves), so resetting on
  // `message` left a socket that reconnects perfectly pinned at the ceiling.
  it('resets the backoff on the handshake, not on the first frame', async () => {
    vi.useFakeTimers()
    $connection.set(gateway('http://gw.local'))
    open()
    await vi.advanceTimersByTimeAsync(0)

    // Five silent connect/drop cycles: without an `open` reset the ladder would
    // climb past the 30s cap and the sixth redial would never land inside 1s.
    for (let i = 0; i < 5; i += 1) {
      sockets.at(-1)!.listeners.get('open')?.({})
      sockets.at(-1)!.listeners.get('close')?.({})
      await vi.advanceTimersByTimeAsync(1_000)
    }

    expect(sockets).toHaveLength(6)

    vi.useRealTimers()
  })

  // Not a cosmetic change: the fixed ladder had every client of one gateway
  // redialling in lockstep after it restarts, each attempt costing a ws-ticket
  // mint. With the jitter source pinned to its floor the first redial is
  // immediate; the fixed ladder's was 2s.
  it('spreads reconnects with jitter rather than a fixed exponential', async () => {
    vi.useFakeTimers()
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    $connection.set(gateway('http://gw.local'))
    open()
    await vi.advanceTimersByTimeAsync(0)

    sockets[0].listeners.get('close')?.({})
    await vi.advanceTimersByTimeAsync(1)

    expect(random).toHaveBeenCalled()
    expect(sockets).toHaveLength(2)

    random.mockRestore()
    vi.useRealTimers()
  })

  // The PR that landed this ticket claimed a failed mint "backs off into the
  // existing reconnect ladder"; nothing tested it.
  it('retries after a ticket mint fails instead of giving up on the socket', async () => {
    vi.useFakeTimers()
    mintWsTicket.mockRejectedValueOnce(new Error('Session expired')).mockResolvedValue('t2')
    $connection.set(gateway('http://gw.local', 'oauth'))
    open()
    await vi.advanceTimersByTimeAsync(0)

    expect(sockets).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(constructed()).toEqual(['ws://gw.local/api/plugins/kanban/events?ticket=t2'])

    vi.useRealTimers()
  })

  // A mint is a server round-trip that consumes a ticket-store entry, and the
  // switch's own redial is already in flight behind one. Without the guard the
  // abandoned gateway's ladder fires into the gap and mints a second.
  it('does not also run the failed connect ladder when the gateway moved under it', async () => {
    vi.useFakeTimers()

    let releaseMint: (ticket: string) => void = () => {}

    mintWsTicket.mockRejectedValueOnce(new Error('Session expired')).mockReturnValue(
      new Promise<string>(resolve => {
        releaseMint = resolve
      })
    )

    $connection.set(gateway('http://old.local', 'oauth'))
    open()
    // The switch lands while the first connect is still awaiting its mint, and
    // its own mint is still outstanding while the stale ladder would fire.
    $connection.set(gateway('http://new.local', 'oauth'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mintWsTicket).toHaveBeenCalledTimes(2)

    releaseMint('t3')
    await vi.advanceTimersByTimeAsync(0)

    expect(constructed()).toEqual(['ws://new.local/api/plugins/kanban/events?ticket=t3'])

    vi.useRealTimers()
  })
})
