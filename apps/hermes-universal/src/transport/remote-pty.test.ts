import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Connection } from '@/store/gateway-config'

import type { TerminalTransportHandlers } from './terminal-transport'

// RemotePtySocket owns the attach token + auto-reconnect. TerminalSocket (the Rust
// WS shim) and the /api/health probe are the two seams; resolveTerminalWsUrl is left
// REAL because it is pure for a `none` backend, so the built URL is what we assert on.

const { instances, MockSocket } = vi.hoisted(() => {
  interface Handlers {
    onBinary: (b: Uint8Array) => void
    onClose: (code?: number, reason?: string) => void
    onError: (m: string) => void
    onOpen: () => void
    onText: (t: string) => void
  }

  const instances: { close: () => void; handlers: Handlers; sent: string[]; url: string }[] = []

  class MockSocket {
    sent: string[] = []

    constructor(
      public url: string,
      public handlers: Handlers
    ) {
      instances.push(this)
    }

    close(): void {}

    sendText(text: string): void {
      this.sent.push(text)
    }
  }

  return { instances, MockSocket }
})

vi.mock('./terminal-socket', () => ({ TerminalSocket: MockSocket }))
vi.mock('@/store/gateway-features', () => ({ gatewayFeatures: vi.fn() }))

import { gatewayFeatures } from '@/store/gateway-features'

import { RemotePtySocket } from './remote-pty'

const mockFeatures = vi.mocked(gatewayFeatures)

const CONN: Connection = { authMode: 'none', baseUrl: 'http://gw.test', mode: 'remote' }

function handlers(): {
  calls: TerminalTransportHandlers
  end: ReturnType<typeof vi.fn>
  ready: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
} {
  const end = vi.fn()
  const ready = vi.fn()
  const status = vi.fn()

  return { calls: { onData: vi.fn(), onEnd: end, onReady: ready, onStatus: status }, end, ready, status }
}

function spawn(h: TerminalTransportHandlers): RemotePtySocket {
  return new RemotePtySocket(CONN, { cols: 80, rows: 24, terminalId: 'term-1' }, h)
}

describe('RemotePtySocket reattach', () => {
  beforeEach(() => {
    instances.length = 0
    mockFeatures.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('appends the attach token only when the gateway advertises reattach', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0].url).toContain('attach=')
  })

  it('dials ephemerally (no token) against a gateway without reattach', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: false })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0].url).not.toContain('attach=')
  })

  it.each([4410, 4401, 4409, 1011] as const)('ends without reconnecting on close code %i', async code => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    instances[0].handlers.onClose(code)

    expect(h.end).toHaveBeenCalledTimes(1)
    expect(h.status).not.toHaveBeenCalled()
    // No re-dial: still the single socket.
    expect(instances).toHaveLength(1)
  })

  it('carries the server close reason into the end state', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    instances[0].handlers.onClose(4404, 'the sandbox container is not running yet')

    // 4404 covers everything from "switched off" to "no sandbox running" — without
    // the reason the pane could only say "Terminal disabled".
    expect(h.end).toHaveBeenCalledWith({
      detail: 'the sandbox container is not running yet',
      kind: 'disabled'
    })
  })

  it('prefers the full banner over the close frame, which RFC 6455 truncates at 123 bytes', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    // What the server actually sends: the whole sentence as a coloured text frame…
    instances[0].handlers.onText(
      '\r\n\u001b[31mTerminal unavailable: the gateway is network-exposed and the shell backend ' +
        'is unsandboxed (terminal.backend: local). Set terminal.backend to docker/ssh, bind the ' +
        'dashboard to loopback, or set terminal.allow_unsandboxed_shell: true.\u001b[0m\r\n'
    )
    // …then the same text on the close frame, clipped mid-word by the 123-byte cap.
    instances[0].handlers.onClose(
      4404,
      'the gateway is network-exposed and the shell backend is unsandboxed (terminal.backend: local). Set terminal.backend to d...'
    )

    const end = h.end.mock.calls[0][0]

    expect(end.kind).toBe('disabled')
    // The remedy is the part the truncation ate; it has to survive.
    expect(end.detail).toContain('allow_unsandboxed_shell')
    expect(end.detail).not.toContain('...')
    // ANSI colouring is stripped — this goes into a text panel, not a terminal.
    expect(end.detail).not.toContain('\u001b[')
  })

  it('falls back to the close reason when no banner was sent', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    // Ordinary shell output must not be mistaken for a refusal banner.
    instances[0].handlers.onText('user@host:~$ echo Terminal unavailable\r\n')
    instances[0].handlers.onClose(4409, 'superseded by another client')

    expect(h.end).toHaveBeenCalledWith({
      detail: 'superseded by another client',
      kind: 'superseded'
    })
  })

  it('still ends cleanly when the close carries no reason', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    instances[0].handlers.onClose(4404)

    expect(h.end).toHaveBeenCalledWith({ detail: undefined, kind: 'disabled' })
  })

  it('reconnects on an abnormal drop and flags the reattach as replayed', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: true })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    expect(h.ready).toHaveBeenLastCalledWith({ host: 'gw.test', replayed: false })

    instances[0].handlers.onClose(1006)
    expect(h.status).toHaveBeenCalledWith('reconnecting')
    expect(h.end).not.toHaveBeenCalled()

    // Backoff base is 500ms; waitFor (1s default) catches the re-dial.
    await vi.waitFor(() => expect(instances).toHaveLength(2))
    instances[1].handlers.onOpen()
    expect(h.ready).toHaveBeenLastCalledWith({ host: 'gw.test', replayed: true })
  })

  it('does not reconnect an ephemeral (tokenless) shell on an abnormal drop', async () => {
    mockFeatures.mockResolvedValue({ shellPty: true, shellPtyReattach: false })
    const h = handlers()
    spawn(h.calls)

    await vi.waitFor(() => expect(instances).toHaveLength(1))
    instances[0].handlers.onOpen()
    instances[0].handlers.onClose(1006)

    expect(h.end).toHaveBeenCalledTimes(1)
    expect(h.status).not.toHaveBeenCalled()
  })
})
