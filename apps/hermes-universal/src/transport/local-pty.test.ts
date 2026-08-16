/**
 * THE LOCAL PTY'S LIFETIME (MJXHRM-373).
 *
 * This socket is where a layout decision becomes a process decision: `close()`
 * invokes `pty_kill`, and its only caller is `TerminalView`'s unmount cleanup.
 * That is why unmounting a terminal ends a shell, and why the zone renderer
 * folding a zone used to end one.
 *
 * It had no test. The two things worth pinning are the two ends of the lifetime:
 * a shell is never spawned before its listeners exist (an early frame would be
 * dropped on the floor), and a socket closed while the spawn is still in flight
 * still kills the shell it is about to receive — otherwise the app forgets the
 * id and the process runs forever with nothing able to address it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }))

const { LocalPtySocket } = await import('./local-pty')

const handlers = () => ({
  onData: vi.fn(),
  onError: vi.fn(),
  onExit: vi.fn(),
  onSpawn: vi.fn()
})

/** Every event the socket subscribed to, in order. */
const subscribed = () => listen.mock.calls.map(call => String(call[0]))

const calls = (command: string) => invoke.mock.calls.filter(call => call[0] === command)

beforeEach(() => {
  invoke.mockReset()
  listen.mockReset()
  listen.mockResolvedValue(() => {})
  invoke.mockResolvedValue({ shell: '/bin/zsh' })
})

describe('spawn handshake', () => {
  it('subscribes to data and exit BEFORE asking for a shell', async () => {
    const socket = new LocalPtySocket({ cols: 80, rows: 24 }, handlers())

    // The subscriptions are awaited, so the spawn cannot have been sent yet.
    expect(calls('pty_spawn')).toHaveLength(0)

    await vi.waitFor(() => expect(calls('pty_spawn')).toHaveLength(1))

    expect(subscribed().map(name => name.split('/').pop())).toEqual(['data', 'exit'])
    expect(socket.isLive).toBe(true)
  })

  it('reports the shell it launched', async () => {
    const on = handlers()
    new LocalPtySocket({ cols: 80, rows: 24 }, on)

    await vi.waitFor(() => expect(on.onSpawn).toHaveBeenCalledWith('/bin/zsh'))
  })
})

describe('close', () => {
  it('kills the shell — the whole reason an unmount ends a terminal', async () => {
    const socket = new LocalPtySocket({ cols: 80, rows: 24 }, handlers())

    await vi.waitFor(() => expect(calls('pty_spawn')).toHaveLength(1))

    socket.close()

    // Synchronously dead to its caller; the kill itself rides the handshake.
    expect(socket.isLive).toBe(false)

    await vi.waitFor(() => expect(calls('pty_kill')).toHaveLength(1))
    expect(calls('pty_kill')[0][1]).toEqual({ id: calls('pty_spawn')[0][1].id })
  })

  it('waits for an in-flight spawn before killing it', async () => {
    // The pane unmounted between `pty_spawn` going out and its reply coming
    // back. The kill must not overtake it: Rust registers the handle when the
    // spawn RESOLVES, so an early kill finds an empty map, does nothing, and the
    // shell that lands a moment later is an orphan nothing can address.
    let settle: (value: unknown) => void = () => {}

    invoke.mockImplementation((command: string) =>
      command === 'pty_spawn' ? new Promise(resolve => (settle = resolve)) : Promise.resolve(undefined)
    )

    const socket = new LocalPtySocket({ cols: 80, rows: 24 }, handlers())

    await vi.waitFor(() => expect(calls('pty_spawn')).toHaveLength(1))

    socket.close()

    // THE ASSERTION: nothing yet, because the shell does not exist yet.
    await Promise.resolve()
    expect(calls('pty_kill')).toHaveLength(0)

    settle({ shell: '/bin/zsh' })

    await vi.waitFor(() => expect(calls('pty_kill')).toHaveLength(1))
  })

  it('never spawns at all when it is closed during the subscribe', async () => {
    // Closed even earlier: before the handshake reached `pty_spawn`. Best of
    // all — there is no shell to kill, so there must be no shell to leak.
    const settlers: ((value: unknown) => void)[] = []

    listen.mockImplementation(() => new Promise(resolve => settlers.push(resolve)))

    const socket = new LocalPtySocket({ cols: 80, rows: 24 }, handlers())

    socket.close()
    settlers.forEach(resolve => resolve(() => {}))

    await vi.waitFor(() => expect(calls('pty_kill').length).toBeGreaterThan(0))
    expect(calls('pty_spawn')).toHaveLength(0)
  })

  it('sends nothing to a shell it has already killed', async () => {
    const socket = new LocalPtySocket({ cols: 80, rows: 24 }, handlers())

    await vi.waitFor(() => expect(calls('pty_spawn')).toHaveLength(1))

    socket.close()
    socket.write('ls\n')
    socket.resize(120, 40)

    expect(calls('pty_write')).toHaveLength(0)
    expect(calls('pty_resize')).toHaveLength(0)
  })
})
