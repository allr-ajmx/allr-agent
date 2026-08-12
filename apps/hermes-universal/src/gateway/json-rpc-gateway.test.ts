/**
 * What a rejected RPC carries.
 *
 * The client used to flatten a JSON-RPC error frame to `new Error(message)`,
 * which is why every "does this backend predate the method?" test in the app
 * had to pattern-match English prose. The code is on the wire; these pin that
 * it survives the transport, because nothing else in the app can put it back.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { JsonRpcGatewayClient } from './json-rpc-gateway'
import { GatewayRpcError } from './rpc-error'

type Listener = (event: never) => void

class FakeSocket {
  readyState: number = WebSocket.CONNECTING
  sent: string[] = []
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
  }

  send(text: string): void {
    this.sent.push(text)
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as never)
    }
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open', {})
  }

  /** Answer the newest outgoing request with a JSON-RPC error frame. */
  failLastRequest(error: Record<string, unknown>): void {
    const last = JSON.parse(this.sent[this.sent.length - 1]) as { id: string }
    this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: last.id, error }) })
  }
}

let socket: FakeSocket | null = null

async function connected(): Promise<JsonRpcGatewayClient> {
  const client = new JsonRpcGatewayClient({
    socketFactory: () => {
      socket = new FakeSocket()
      queueMicrotask(() => socket?.open())

      return socket as unknown as WebSocket
    }
  })

  await client.connect('ws://localhost:1/ws')

  return client
}

afterEach(() => {
  socket = null
})

describe('JsonRpcGatewayClient error frames', () => {
  it('rejects with the JSON-RPC code the gateway sent, not just its prose', async () => {
    const client = await connected()
    const pending = client.request('projects.list')

    socket?.failLastRequest({ code: -32601, message: 'unknown method: projects.list' })

    const error = await pending.catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GatewayRpcError)
    expect((error as GatewayRpcError).code).toBe(-32601)
    expect((error as GatewayRpcError).message).toBe('unknown method: projects.list')
  })

  it('keeps error.data and reports no code when the frame omits one', async () => {
    const client = await connected()
    const withData = client.request('billing.charge')

    socket?.failLastRequest({ code: 5061, data: { retry_after: 3 }, message: 'boom' })

    const dataError = (await withData.catch((e: unknown) => e)) as GatewayRpcError

    expect(dataError.code).toBe(5061)
    expect(dataError.data).toEqual({ retry_after: 3 })

    const codeless = client.request('session.title')

    socket?.failLastRequest({ message: 'boom' })

    const codelessError = (await codeless.catch((e: unknown) => e)) as GatewayRpcError

    // null, NOT 0 — a caller reading this must be able to tell "the gateway did
    // not say" from any real code, or it will answer questions it cannot answer.
    expect(codelessError.code).toBeNull()
    expect(codelessError.message).toBe('boom')
  })
})
