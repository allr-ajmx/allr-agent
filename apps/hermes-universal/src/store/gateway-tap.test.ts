/**
 * The plugin tap must actually be wired into the live stream — `onGatewayEvent`
 * has no value if nothing calls `emitGatewayEvent`. This pins the wiring AND its
 * documented ordering (plugins observe the raw event before the app's own
 * listeners, THE session event router included — it registers through
 * `addGatewayEventListener` like everything else, see store/event-router.ts).
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
vi.mock('@/store/gateway-config', () => ({ resolveWsUrl: vi.fn(async () => 'ws://localhost:1/ws') }))
vi.mock('@/transport/tauri-websocket', () => ({ TauriWebSocket: class {} }))

import { onGatewayEvent } from '@/contrib/events'
import type { Connection } from '@/store/gateway-config'

import { addGatewayEventListener, closeGateway, connectGateway } from './gateway'

afterEach(() => {
  closeGateway()
  captured = null
  vi.clearAllMocks()
})

describe('gateway → plugin tap', () => {
  it("fans every event to the tap, before the app's own listeners", async () => {
    const order: string[] = []
    const disposeListener = addGatewayEventListener(() => void order.push('listener'))
    const dispose = onGatewayEvent('*', () => void order.push('plugin'))

    await connectGateway({ baseUrl: 'http://localhost:1' } as Connection)
    expect(captured).toBeTypeOf('function')

    captured?.({ type: 'message.delta' })

    expect(order).toEqual(['plugin', 'listener'])

    dispose()
    disposeListener()
  })

  it("a throwing plugin listener never stops the app's own", async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const listener = vi.fn()
    const disposeListener = addGatewayEventListener(listener)

    const dispose = onGatewayEvent('*', () => {
      throw new Error('plugin exploded')
    })

    await connectGateway({ baseUrl: 'http://localhost:1' } as Connection)
    captured?.({ type: 'message.delta' })

    expect(listener).toHaveBeenCalledOnce()

    dispose()
    disposeListener()
    spy.mockRestore()
  })
})
