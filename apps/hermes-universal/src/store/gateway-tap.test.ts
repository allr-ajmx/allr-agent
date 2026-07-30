/**
 * The plugin tap must actually be wired into the live stream — `onGatewayEvent`
 * has no value if nothing calls `emitGatewayEvent`. This pins the wiring AND its
 * documented ordering (plugins observe the raw event before the chat reducer).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

type AnyListener = (event: { type: string }) => void

let captured: AnyListener | null = null

vi.mock('@/gateway', () => ({
  JsonRpcGatewayClient: class {
    close() {}
    async connect() {}
    onAny(listener: AnyListener) {
      captured = listener
    }
    onState() {}
  }
}))
vi.mock('@/store/chat', () => ({ handleGatewayEvent: vi.fn() }))
vi.mock('@/store/gateway-config', () => ({ resolveWsUrl: vi.fn(async () => 'ws://localhost:1/ws') }))
vi.mock('@/transport/tauri-websocket', () => ({ TauriWebSocket: class {} }))

import { onGatewayEvent } from '@/contrib/events'
import type { Connection } from '@/store/gateway-config'

import { handleGatewayEvent } from './chat'
import { closeGateway, connectGateway } from './gateway'

afterEach(() => {
  closeGateway()
  captured = null
  vi.clearAllMocks()
})

describe('gateway → plugin tap', () => {
  it('fans every event to the tap, before the chat reducer', async () => {
    const order: string[] = []
    vi.mocked(handleGatewayEvent).mockImplementation(() => void order.push('reducer'))

    const dispose = onGatewayEvent('*', () => void order.push('plugin'))

    await connectGateway({ baseUrl: 'http://localhost:1' } as Connection)
    expect(captured).toBeTypeOf('function')

    captured?.({ type: 'message.delta' })

    expect(order).toEqual(['plugin', 'reducer'])

    dispose()
  })

  it('a throwing plugin listener never stops the reducer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const dispose = onGatewayEvent('*', () => {
      throw new Error('plugin exploded')
    })

    await connectGateway({ baseUrl: 'http://localhost:1' } as Connection)
    captured?.({ type: 'message.delta' })

    expect(handleGatewayEvent).toHaveBeenCalledOnce()

    dispose()
    spy.mockRestore()
  })
})
