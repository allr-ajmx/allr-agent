/**
 * MJXHRM-308 — a tile's composer scope has to follow its session's KEY.
 *
 * A stale-runtime recovery rekeys the slice onto a fresh runtime id
 * (`store/session-recovery.ts`) and `store/prompts.ts` carries the blocking
 * prompts across with it, but nothing patches the tile record's cached
 * `runtimeId`. The scope was built from that cached id, so after a recovery the
 * composer's awaiting-input edge was subscribed to a key nothing writes any
 * more — and Esc, which reads exactly that edge, would interrupt a turn that is
 * actually parked on a clarify, discarding the question.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useComposerScope } from '@/app/chat/composer/scope'
import { useStore } from '@/store/atom'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn().mockResolvedValue({})
  }
})

// The whole point of the tile is the ChatScreen subtree; the assertion is about
// the SCOPE that subtree is handed, so stand in for it with a probe.
vi.mock('@/app/chat/chat-screen', () => ({
  ChatScreen: () => {
    const scope = useComposerScope()

    return <span data-testid="awaiting">{String(useStore(scope.$awaitingInput))}</span>
  }
}))

const { $sessionTiles, patchSessionTile } = await import('@/store/session-states')

const { $sessionStates, emptySessionState, publishSessionState, rekeySession } =
  await import('@/store/session-state-types')

const { setSessionClarify } = await import('@/store/prompts')
const { SessionTilePane } = await import('./session-tile')

beforeEach(() => {
  $sessionStates.set({})
  $sessionTiles.set([])
})

describe('SessionTilePane composer scope', () => {
  it('follows the slice onto a recovered runtime id', async () => {
    publishSessionState('runtime-1', { ...emptySessionState('stored-1'), runtimeSessionId: 'runtime-1' })
    $sessionTiles.set([{ storedSessionId: 'stored-1' }])
    patchSessionTile('stored-1', { runtimeId: 'runtime-1' })
    setSessionClarify('runtime-1', { requestId: 'c1', question: 'which one?', choices: null })

    render(<SessionTilePane storedSessionId="stored-1" />)

    expect(screen.getByTestId('awaiting').textContent).toBe('true')

    // What a stale-runtime recovery does. The tile record still says
    // `runtime-1`; only the reverse index knows the session moved.
    rekeySession('runtime-1', 'runtime-2', { runtimeSessionId: 'runtime-2' })

    expect(await screen.findByText('true')).toBeTruthy()
    expect($sessionTiles.get()[0].runtimeId).toBe('runtime-1')
  })
})
