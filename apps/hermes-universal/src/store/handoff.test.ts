import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// $gatewayState must be present: store/connection subscribes to it at import
// time, and it is pulled in transitively via store/chat.
vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn(),
    $gatewayState: atom('open'),
    getGatewayClient: () => null
  }
})

import { $messages } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { resetSessionStates, seedActiveSession } from '@/test-sessions'

import { handoffSession } from './handoff'

const systemLines = () =>
  $messages
    .get()
    .filter(m => m.role === 'system')
    .map(m => m.parts.map(p => ('text' in p ? p.text : '')).join(''))

beforeEach(() => {
  vi.useFakeTimers()
  resetSessionStates()
  seedActiveSession('runtime-1')
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/** Advance past the poll sleeps while the handoff promise is in flight. */
const settle = async (promise: Promise<unknown>) => {
  for (let tick = 0; tick < 5; tick += 1) {
    await vi.advanceTimersByTimeAsync(800)
  }

  return promise
}

describe('handoffSession', () => {
  it('requests the handoff then polls to completion', async () => {
    vi.mocked(requestGateway)
      .mockResolvedValueOnce({ queued: true } as never)
      .mockResolvedValueOnce({ state: 'running' } as never)
      .mockResolvedValueOnce({ state: 'completed' } as never)

    const states: string[] = []
    const result = await settle(handoffSession('Telegram', { onProgress: state => states.push(state) }))

    expect(requestGateway).toHaveBeenNthCalledWith(1, 'handoff.request', {
      platform: 'telegram',
      session_id: 'runtime-1'
    })
    expect(result).toEqual({ ok: true })
    expect(states).toEqual(['pending', 'running', 'completed'])
    expect(systemLines()[0]).toContain('telegram')
  })

  it('surfaces the gateway error when the transfer fails', async () => {
    vi.mocked(requestGateway)
      .mockResolvedValueOnce({ queued: true } as never)
      .mockResolvedValueOnce({ state: 'failed', error: 'no telegram bot token' } as never)

    await expect(settle(handoffSession('telegram'))).resolves.toEqual({
      ok: false,
      error: 'no telegram bot token'
    })
    expect(systemLines()).toEqual([])
  })

  it('fails fast when the request itself is rejected', async () => {
    vi.mocked(requestGateway).mockRejectedValueOnce(new Error('Error: unknown platform'))

    const result = await handoffSession('nope')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('unknown platform')
  })

  it('refuses without a session and without a platform', async () => {
    seedActiveSession('draft', { runtimeSessionId: null, storedSessionId: null })
    expect((await handoffSession('telegram')).ok).toBe(false)

    seedActiveSession('runtime-1')
    expect((await handoffSession('   ')).ok).toBe(false)
    expect(requestGateway).not.toHaveBeenCalled()
  })
})
