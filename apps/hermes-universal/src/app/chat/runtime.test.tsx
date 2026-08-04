import type { ThreadMessageLike } from '@assistant-ui/react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Capture the adapter handed to the runtime so the converter can be inspected
// directly — mounting a whole thread isn't needed to pin this contract down.
let adapter: { convertMessage?: (message: unknown) => ThreadMessageLike } | null = null

vi.mock('@assistant-ui/react', () => ({
  AssistantRuntimeProvider: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  useExternalStoreRuntime: (store: { convertMessage?: (message: unknown) => ThreadMessageLike }) => {
    adapter = store

    return {}
  }
}))

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn(),
    $gatewayState: atom('open'),
    getGatewayClient: () => null
  }
})

import { ChatRuntimeProvider } from './runtime'

const convert = (message: unknown): ThreadMessageLike => {
  render(<ChatRuntimeProvider>{null}</ChatRuntimeProvider>)

  const convertMessage = adapter?.convertMessage

  if (!convertMessage) {
    throw new Error('runtime adapter did not expose convertMessage')
  }

  return convertMessage(message)
}

describe('ChatRuntimeProvider convertMessage', () => {
  // REGRESSION: assistant-ui falls back to a generated id when the converter
  // omits one (`fromThreadMessageLike`: `id: id ?? fallbackId`). The edit
  // composer then sends `sourceId = <generated id>`, which our store can't
  // resolve — so editing a prompt and pressing Enter silently did nothing.
  it('passes the store id through so id-addressed actions can resolve the turn', () => {
    const converted = convert({ id: 'm7-1699', role: 'user', parts: [{ type: 'text', text: 'hi' }] })

    expect(converted.id).toBe('m7-1699')
  })

  it('maps assistant state onto a message status', () => {
    expect(convert({ id: 'a1', role: 'assistant', parts: [], pending: true }).status).toEqual({ type: 'running' })
    expect(convert({ id: 'a2', role: 'assistant', parts: [], error: 'boom' }).status).toEqual({
      type: 'incomplete',
      reason: 'error',
      error: 'boom'
    })
    expect(convert({ id: 'a3', role: 'assistant', parts: [] }).status).toEqual({ type: 'complete', reason: 'stop' })
    // Only assistant messages carry a status.
    expect(convert({ id: 'u1', role: 'user', parts: [] }).status).toBeUndefined()
  })
})
