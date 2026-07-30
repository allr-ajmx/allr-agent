import { describe, expect, it, vi } from 'vitest'

import type { RpcEvent } from '@/types/hermes'

import { emitGatewayEvent, onGatewayEvent } from './events'

const event = (type: string, payload?: unknown): RpcEvent => ({ payload, type })

describe('gateway event tap', () => {
  it('delivers to type subscribers and to the wildcard', () => {
    const typed = vi.fn()
    const wild = vi.fn()
    const other = vi.fn()

    const disposers = [
      onGatewayEvent('message.delta', typed),
      onGatewayEvent('*', wild),
      onGatewayEvent('tool.start', other)
    ]

    emitGatewayEvent(event('message.delta', { text: 'hi' }))

    expect(typed).toHaveBeenCalledWith({ payload: { text: 'hi' }, type: 'message.delta' })
    expect(wild).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()

    for (const dispose of disposers) {
      dispose()
    }
  })

  it('isolates a throwing listener from its neighbours', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()

    const disposers = [
      onGatewayEvent('boom', () => {
        throw new Error('plugin exploded')
      }),
      onGatewayEvent('boom', after),
      onGatewayEvent('*', after)
    ]

    expect(() => emitGatewayEvent(event('boom'))).not.toThrow()
    // Once for the typed channel, once for the wildcard.
    expect(after).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalled()

    for (const dispose of disposers) {
      dispose()
    }

    spy.mockRestore()
  })

  it('stops delivering after dispose', () => {
    const listener = vi.fn()
    const dispose = onGatewayEvent('session.info', listener)

    emitGatewayEvent(event('session.info'))
    expect(listener).toHaveBeenCalledOnce()

    dispose()
    emitGatewayEvent(event('session.info'))
    expect(listener).toHaveBeenCalledOnce()
  })
})
