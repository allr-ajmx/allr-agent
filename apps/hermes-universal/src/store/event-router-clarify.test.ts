import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('idle')
  }
})

vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn().mockResolvedValue(undefined) }))

import { routeGatewayEvent } from '@/store/event-router'
import { clearAllPrompts, sessionClarifyRequest } from '@/store/prompts'
import { $activeSessionKey, $sessionStates } from '@/store/session-state-types'

const event = (type: string, payload: Record<string, unknown>): GatewayEvent =>
  ({ type, session_id: 's1', payload }) as GatewayEvent

/**
 * MJXHRM-362. The clarify tool RETURNING is its request's terminal event, and
 * the one signal every ending shares: the user answered, the backend's `_block`
 * timed out, or `session.interrupt` released it with `_clear_pending`. Only the
 * answered path cleared the request (`respondClarify`), so a timed-out or
 * interrupted clarify stayed "parked" until `message.complete` — and
 * `$activeSessionAwaitingInput` is what makes Esc decline to interrupt a turn
 * waiting on the user, so Esc was dead for the rest of that turn.
 */
describe('event-router → clarify lifecycle', () => {
  beforeEach(() => {
    clearAllPrompts()
    $sessionStates.set({})
    $activeSessionKey.set('s1')
  })

  const raise = () =>
    routeGatewayEvent(event('clarify.request', { request_id: 'req-1', question: 'Which branch?', choices: ['main'] }))

  it('parks the request the panel answers from', () => {
    raise()

    expect(sessionClarifyRequest('s1').get()).toEqual({
      requestId: 'req-1',
      question: 'Which branch?',
      choices: ['main']
    })
  })

  it('releases it when the clarify tool returns, however it ended', () => {
    raise()
    routeGatewayEvent(event('tool.complete', { name: 'clarify', tool_id: 'call_abc123', result: '' }))

    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  it('leaves it parked while some other tool finishes', () => {
    raise()
    routeGatewayEvent(event('tool.complete', { name: 'bash', tool_id: 'call_x', result: 'ok' }))

    expect(sessionClarifyRequest('s1').get()?.requestId).toBe('req-1')
  })
})
