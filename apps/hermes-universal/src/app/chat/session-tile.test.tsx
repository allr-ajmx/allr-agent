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

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useComposerScope } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
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
    const view = useSessionView()

    return (
      <span data-testid="awaiting">
        {String(useStore(scope.$awaitingInput))}
        <b data-testid="key">{String(useStore(view.$runtimeId))}</b>
      </span>
    )
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
  it('sees a clarify raised after a recovery moved the slice', async () => {
    publishSessionState('runtime-1', { ...emptySessionState('stored-1'), runtimeSessionId: 'runtime-1' })
    $sessionTiles.set([{ storedSessionId: 'stored-1' }])
    patchSessionTile('stored-1', { runtimeId: 'runtime-1' })

    render(<SessionTilePane storedSessionId="stored-1" />)

    expect(screen.getByTestId('awaiting').textContent).toBe('falseruntime-1')

    // What a stale-runtime recovery does. The tile record is NOT patched — only
    // the reverse index learns the session moved — so a scope built from the
    // cached `runtimeId` goes on watching a key nothing writes any more.
    act(() => {
      rekeySession('runtime-1', 'runtime-2', { runtimeSessionId: 'runtime-2' })
    })

    // The tile record still names the dead runtime; only the reverse index — and
    // therefore `tileRuntimeKey` — knows where the session went.
    expect($sessionTiles.get()[0].runtimeId).toBe('runtime-1')
    expect(screen.getByTestId('key').textContent).toBe('runtime-2')

    // The gateway parks the recovered turn on a question. Bound to the dead key
    // this stays `false`, and Esc then interrupts the turn instead of leaving
    // the clarify answerable.
    act(() => {
      setSessionClarify('runtime-2', { requestId: 'c1', question: 'which one?', choices: null })
    })

    expect(await screen.findByText('true')).toBeTruthy()
  })
})
