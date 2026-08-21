/**
 * The tile side of the turn-lifecycle layer (MJXHRM-356, MJXHRM-308).
 *
 * Tiles used to submit without opening a turn and to hydrate by publishing
 * straight onto the runtime id — so a tiled session had no reconnect
 * reconciliation, no crash recovery, and, on a stale-runtime recovery, a slice
 * stranded under a dead key that hung busy forever with nothing to retry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionTileDelegate } from '@/store/session-states'

const requestGateway = vi.fn()
const getSessionMessages = vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[] }))
const notifyError = vi.fn()

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: (...args: unknown[]) => requestGateway(...args)
  }
})

// `setApiRequestProfile` is called at MODULE SCOPE by store/profiles, which
// store/chat now reaches (a new chat carries the active profile on
// `session.create`). A mock missing it fails the whole file at import, before a
// single test runs.
vi.mock('@/hermes', () => ({
  getSessionMessages: (...args: unknown[]) => getSessionMessages(...args),
  setApiRequestProfile: vi.fn()
}))

vi.mock('@/store/notifications', () => ({
  clearNotifications: vi.fn(),
  notifyError: (...args: unknown[]) => notifyError(...args),
  notifySuccess: vi.fn()
}))

// The delegate registers itself on import; capture what it registered.
let delegate: SessionTileDelegate

const captured = vi.fn((next: SessionTileDelegate) => {
  delegate = next
})

vi.mock('@/store/session-states', async () => {
  const types = await import('@/store/session-state-types')

  return {
    ...types,
    closeSessionTile: vi.fn(),
    openBranchTile: vi.fn(),
    setSessionTileDelegate: (next: SessionTileDelegate) => captured(next)
  }
})

vi.mock('@/store/session', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $sessions: atom([]),
    archiveSessionLocal: vi.fn(),
    branchStoredSession: vi.fn(),
    deleteSessionLocal: vi.fn(),
    knownSessionProfile: () => undefined,
    resolveSessionProfile: async () => undefined,
    sessionProfileIsAmbiguous: () => false
  }
})

await import('./session-tile-delegate')

const { $sessionStates, addSessionKeyHooks, clearStoredIdIndex, emptySessionState, hydratingKey, publishSessionState } =
  await import('@/store/session-state-types')

const { $inflightTurns, clearAllTurns, getInflightTurn } = await import('@/store/turn-lifecycle')

beforeEach(() => {
  requestGateway.mockReset()
  getSessionMessages.mockReset().mockResolvedValue({ messages: [] })
  notifyError.mockReset()
  $sessionStates.set({})
  clearStoredIdIndex()
  clearAllTurns()
})

const seed = (key: string, patch: Record<string, unknown> = {}) =>
  publishSessionState(key, { ...emptySessionState(key), runtimeSessionId: key, ...patch })

describe('resumeTile', () => {
  it('hydrates through the hydrating → runtime rekey seam, not a bare publish', async () => {
    requestGateway.mockResolvedValue({ session_id: 'runtime-1', running: false, messages: [] })

    // The SEAM, not its outcome. This test asserted only the resulting map, and
    // a `dropSessionState` + `publishSessionState` pair — exactly the bare
    // publish it is named for — leaves an identical map while firing neither
    // crash-journal recovery nor live-tail reconciliation. It therefore passed
    // against the very regression it exists to catch (MJXHRM-308's audit).
    // `store/turn-hydration.ts` hangs both off this key move, so the key move
    // is the assertion.
    const moves: Array<[string, string]> = []

    const stopWatching = addSessionKeyHooks({
      drop: () => {},
      rekey: (fromKey, toKey) => {
        moves.push([fromKey, toKey])
      }
    })

    try {
      const runtimeId = await delegate.resumeTile('stored-1')

      expect(runtimeId).toBe('runtime-1')
      expect(moves).toEqual([[hydratingKey('stored-1'), 'runtime-1']])
    } finally {
      stopWatching()
    }

    // And the placeholder is GONE, moved rather than left beside a second slice.
    expect(Object.keys($sessionStates.get())).toEqual(['runtime-1'])
    expect($sessionStates.get()['runtime-1']).toMatchObject({
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'stored-1'
    })
  })

  it('adopts a mid-turn resume as a live turn so a reconnect can reconcile it', async () => {
    requestGateway.mockResolvedValue({
      session_id: 'runtime-1',
      running: true,
      messages: [],
      inflight: { user: 'do the thing', streaming: true }
    })

    await delegate.resumeTile('stored-1')

    expect(getInflightTurn('runtime-1')).toMatchObject({ origin: 'remote', prompt: 'do the thing' })
  })

  it('leaves no orphan placeholder behind when the resume fails', async () => {
    requestGateway.mockRejectedValue(new Error('gateway said no'))

    await expect(delegate.resumeTile('stored-1')).rejects.toThrow('gateway said no')
    expect($sessionStates.get()).toEqual({})
  })

  it('adopts a warm slice without re-resuming', async () => {
    seed('runtime-1', { storedSessionId: 'stored-1' })

    expect(await delegate.resumeTile('stored-1')).toBe('runtime-1')
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

describe('submitToSession', () => {
  // Every tile submit lands here — a typed message and the message a slash
  // `send` directive resolves to alike (app/chat/surface-submit), which is what
  // gives a slash run in a tile the same turn record and the same visible busy
  // state as typing (MJXHRM-419).
  it('opens the in-flight turn before the submit leaves, and shows busy', async () => {
    seed('runtime-1', { storedSessionId: 'stored-1' })
    requestGateway.mockResolvedValue({})

    await delegate.submitToSession('runtime-1', 'hello')

    expect(getInflightTurn('runtime-1')).toMatchObject({ prompt: 'hello', origin: 'local' })
    expect(requestGateway).toHaveBeenCalledWith('prompt.submit', { session_id: 'runtime-1', text: 'hello' })

    const state = $sessionStates.get()['runtime-1']

    expect(state).toMatchObject({ busy: true })
    expect(state?.turnStartedAt).not.toBeNull()
    // ...and the transcript keeps a record of what was sent.
    expect(state?.messages.at(-1)).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'hello' }] })
  })

  // MJXHRM-308: the default `onRecovered` resolved the LIVE id through the
  // stored-id index, so it did nothing for any resumed session. The slice stayed
  // under its dead key, the router addressed frames by the new one, and the tile
  // hung busy forever — no error, no retry.
  it('rekeys the tile onto the recovered runtime id', async () => {
    seed('runtime-1', { storedSessionId: 'stored-1' })

    requestGateway.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session.resume') {
        return { session_id: 'runtime-2' }
      }

      if (params?.session_id === 'runtime-1') {
        throw new Error('session not found: runtime-1')
      }

      return {}
    })

    await delegate.submitToSession('runtime-1', 'hello')

    expect($sessionStates.get()['runtime-1']).toBeUndefined()
    expect($sessionStates.get()['runtime-2']).toMatchObject({ busy: true, storedSessionId: 'stored-1' })
    // The open turn followed the slice, so a terminal frame can still settle it.
    expect(getInflightTurn('runtime-2')).toMatchObject({ prompt: 'hello' })
  })

  it('settles the turn and clears busy when the submit never lands', async () => {
    seed('runtime-1', { storedSessionId: 'stored-1' })
    requestGateway.mockRejectedValue(new Error('transport is gone'))

    await delegate.submitToSession('runtime-1', 'hello')

    expect($sessionStates.get()['runtime-1']).toMatchObject({ busy: false, turnStartedAt: null })
    expect($inflightTurns.get()['runtime-1']?.phase).toBe('settled')
    expect(notifyError).toHaveBeenCalled()
  })
})

// MJXHRM-419: the delegate used to carry an `executeSlash` that submitted the
// raw command as prompt text. It never had a caller — a tile's composer
// dispatches slashes through `app/chat/hooks/use-slash-command` under the tile's
// own view — and routing through it would have sent `/model`, `/new` and every
// other client-side verb to the agent as words. It is gone; this pins that it
// stays gone, so nothing wires it back up.
describe('the delegate surface', () => {
  it('offers no executeSlash for a caller to route slashes through', () => {
    expect('executeSlash' in delegate).toBe(false)
  })
})

// MJXHRM-388: the branch made from a TAB and the one made from an assistant
// message share `openBranchTile`, so they cannot drift — and the parent it is
// given is what puts the new tab in the parent's own strip rather than the
// workspace's.
describe('branchSession', () => {
  beforeEach(async () => {
    const { openBranchTile } = await import('@/store/session-states')

    vi.mocked(openBranchTile).mockClear()
  })

  it('opens the branch beside the session it was branched from', async () => {
    const { branchStoredSession } = await import('@/store/session')
    const { openBranchTile } = await import('@/store/session-states')

    vi.mocked(branchStoredSession).mockResolvedValue('branch-1')

    await delegate.branchSession('stored-1')

    expect(openBranchTile).toHaveBeenCalledWith('branch-1', 'stored-1')
  })

  it('opens nothing when the fork failed', async () => {
    const { branchStoredSession } = await import('@/store/session')
    const { openBranchTile } = await import('@/store/session-states')

    vi.mocked(branchStoredSession).mockResolvedValue(null)

    await delegate.branchSession('stored-1')

    expect(openBranchTile).not.toHaveBeenCalled()
  })
})
