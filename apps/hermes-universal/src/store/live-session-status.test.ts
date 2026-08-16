/**
 * Rehydration is the half of live-sync that has to be RIGHT rather than merely
 * fast: it writes busy/needs-input straight into `$sessionStates`, so a wrong
 * key duplicates a conversation and a wrong reap clears a turn that is still
 * running. The reap in particular has no visible failure mode — the row just
 * goes quiet — which is exactly why it is pinned down here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('idle')
  }
})

vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  listAllProfileSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 })
}))

import { listAllProfileSessions } from '@/hermes'
import { $gatewayState, requestGateway } from '@/store/gateway'
import {
  type LiveSessionStatusItem,
  type LiveSessionStatusResponse,
  rehydrateLiveSessionStatuses,
  resetLiveRuntimeTracking,
  SESSIONS_LIST_TICK_GAP_MS,
  startLiveSessionSync
} from '@/store/live-session-status'
import { $changeEventsAvailable, $sessionsChangeTick, resetLiveSync } from '@/store/live-sync'
import {
  $activeStoredSessionId,
  $attentionSessionIds,
  $unreadFinishedSessionIds,
  $workingSessionIds
} from '@/store/session'
import {
  $activeSessionKey,
  $sessionStates,
  emptySessionState,
  publishSessionState,
  runtimeKeyForStoredSession
} from '@/store/session-state-types'
import { $stalledSessionIds, clearAllSessionStates, SESSION_WATCHDOG_TIMEOUT_MS } from '@/store/session-states'

const snapshot = (...sessions: LiveSessionStatusItem[]): LiveSessionStatusResponse => ({ sessions })

const seed = (key: string, patch: Partial<ReturnType<typeof emptySessionState>>) =>
  publishSessionState(key, { ...emptySessionState(patch.storedSessionId ?? null), ...patch })

beforeEach(() => {
  clearAllSessionStates()
  resetLiveRuntimeTracking()
  $activeSessionKey.set('idle-active')
  $activeStoredSessionId.set(null)
  $unreadFinishedSessionIds.set([])
  seed('idle-active', { runtimeSessionId: 'idle-active', storedSessionId: 'idle-active' })
})

describe('rehydrateLiveSessionStatuses', () => {
  it('lights up a session running somewhere else, which this client has never opened', () => {
    // A cron tick / an inbound messaging turn / the TUI. Nothing in the stream
    // ever told us, which is the whole point of the snapshot.
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-1', session_key: 'stored-1', status: 'working' }))

    expect($workingSessionIds.get().has('stored-1')).toBe(true)
  })

  it('leaves a live stranger with NOTHING a warm short-circuit could adopt', () => {
    // The regression this split exists for (MJXHRM-356). The snapshot used to
    // publish a `$sessionStates` slice for a session it had only HEARD about: no
    // transcript, no `session.resume`, no transport bound to this webview — but
    // WITH a `storedSessionId`, so `publishSessionState` indexed it.
    //
    // `runtimeKeyForStoredSession` returning a key IS the warm test both
    // `store/session.ts#openSession` and the tile delegate's
    // `resumeSessionToState` gate on, and a hit means "already whole, nothing to
    // fetch". Opening the session therefore adopted the empty stub and skipped
    // the `hydrating: → runtime` rekey — and with it live-tail reconciliation,
    // crash-journal recovery, and `adoptResumedTurn` putting the session into
    // `$inflightTurns` where a reconnect can find it. A session the gateway
    // reports live that we hold no slice for is, by construction, the case right
    // after a crash: exactly when that recovery is the whole point.
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-warm', session_key: 'stored-warm', status: 'working' }))

    expect(runtimeKeyForStoredSession('stored-warm')).toBeNull()
    expect($sessionStates.get()['rt-warm']).toBeUndefined()
    // …and the row still lights up, which is the only reason the stub existed.
    expect($workingSessionIds.get().has('stored-warm')).toBe(true)
  })

  it('raises the attention dot for a stranger parked on a clarify', () => {
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-wait', session_key: 'stored-wait', status: 'waiting' }))

    expect($attentionSessionIds.get()).toContain('stored-wait')
    expect($workingSessionIds.get().has('stored-wait')).toBe(true)
  })

  it('lets the SLICE answer for a session this client actually holds', () => {
    // The snapshot trails a poll behind; the slice settles on the terminal
    // frame. A finished turn must not keep its spinner for up to 30s just
    // because the registry still lists it.
    seed('rt-own', { busy: true, runtimeSessionId: 'rt-own', storedSessionId: 'stored-own' })
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-own', session_key: 'stored-own', status: 'working' }))

    expect($workingSessionIds.get().has('stored-own')).toBe(true)

    publishSessionState('rt-own', { ...$sessionStates.get()['rt-own'], busy: false })

    expect($workingSessionIds.get().has('stored-own')).toBe(false)
  })

  it('does NOT create a slice for an idle stranger', () => {
    // Universal caps `$sessionStates` and prunes idle slices on every growth, so
    // seeding one per snapshot row would churn create→prune→republish forever.
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-idle', session_key: 'stored-idle', status: 'idle' }))

    expect($sessionStates.get()['rt-idle']).toBeUndefined()
  })

  it('writes into the slice a conversation ALREADY has, rather than opening a second one', () => {
    // The universal-only case desktop cannot hit: a chat mid-resume lives under
    // a `hydrating:` placeholder, not under a runtime id.
    seed('hydrating:stored-2', { runtimeSessionId: null, storedSessionId: 'stored-2' })

    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-2', session_key: 'stored-2', status: 'waiting' }))

    expect($sessionStates.get()['rt-2']).toBeUndefined()
    expect($sessionStates.get()['hydrating:stored-2']).toMatchObject({ busy: true, needsInput: true })
    expect(runtimeKeyForStoredSession('stored-2')).toBe('hydrating:stored-2')
  })

  it('refuses to darken a turn submitted between the snapshot and its first token', () => {
    // The backend honestly reports idle; the local stream is the newer truth.
    seed('rt-3', {
      awaitingResponse: true,
      busy: true,
      runtimeSessionId: 'rt-3',
      sawAssistantPayload: false,
      storedSessionId: 'stored-3'
    })

    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-3', session_key: 'stored-3', status: 'idle' }))

    expect($sessionStates.get()['rt-3'].busy).toBe(true)
  })

  it('marks a working session quiet once it is past the watchdog timeout', () => {
    const now = 10 * 60 * 1000

    rehydrateLiveSessionStatuses(
      snapshot({
        id: 'rt-4',
        last_active: (now - SESSION_WATCHDOG_TIMEOUT_MS - 1_000) / 1000,
        session_key: 'stored-4',
        status: 'working'
      }),
      now
    )

    expect($stalledSessionIds.get()).toContain('stored-4')
  })
})

describe('reaping runtimes that vanish between snapshots', () => {
  it('darkens a STRANGER the gateway dropped, and marks its row unread', () => {
    // No slice to publish a busy→idle transition through, so the "your turn" dot
    // has to come off the registry diff instead — otherwise a cron / messaging /
    // TUI turn finishing while nothing local held the session went unannounced.
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-5', session_key: 'stored-5', status: 'working' }))

    expect($workingSessionIds.get().has('stored-5')).toBe(true)

    rehydrateLiveSessionStatuses(snapshot())

    expect($workingSessionIds.get().has('stored-5')).toBe(false)
    expect($unreadFinishedSessionIds.get()).toContain('stored-5')
  })

  it('settles the SLICE of a session the gateway dropped, so the spinner clears', () => {
    // The busy→idle EDGE is what marks it unread; a silent delete would not.
    seed('rt-5b', { busy: true, runtimeSessionId: 'rt-5b', storedSessionId: 'stored-5b' })
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-5b', session_key: 'stored-5b', status: 'working' }))
    rehydrateLiveSessionStatuses(snapshot())

    expect($sessionStates.get()['rt-5b']).toMatchObject({ busy: false, needsInput: false, streamId: null })
    expect($workingSessionIds.get().has('stored-5b')).toBe(false)
  })

  it('reaps a session whose slice was rekeyed onto its runtime id in the meantime', () => {
    seed('hydrating:stored-6', { runtimeSessionId: null, storedSessionId: 'stored-6' })
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-6', session_key: 'stored-6', status: 'working' }))

    // The resume landed: the slice moved to the runtime id the snapshot named.
    clearAllSessionStates()
    seed('rt-6', { busy: true, runtimeSessionId: 'rt-6', storedSessionId: 'stored-6' })

    rehydrateLiveSessionStatuses(snapshot())

    expect($sessionStates.get()['rt-6'].busy).toBe(false)
  })

  it('does NOT clear a turn belonging to a DIFFERENT run of the same conversation', () => {
    // A resume mints a fresh runtime id for the same stored session. Desktop
    // cannot hit this (its keys ARE runtime ids); resolving through the stored
    // id can, and an unguarded settle would kill a live turn.
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-old', session_key: 'stored-7', status: 'working' }))

    clearAllSessionStates()
    seed('rt-new', { busy: true, runtimeSessionId: 'rt-new', storedSessionId: 'stored-7' })

    rehydrateLiveSessionStatuses(snapshot())

    expect($sessionStates.get()['rt-new'].busy).toBe(true)
  })

  it('only reaps what the SAME profile previously saw', () => {
    seed('rt-8', { busy: true, runtimeSessionId: 'rt-8', storedSessionId: 'stored-8' })

    rehydrateLiveSessionStatuses(
      snapshot({ id: 'rt-8', session_key: 'stored-8', status: 'working' }),
      Date.now(),
      'work'
    )

    // Another profile's gateway reports an empty registry — it never saw rt-8.
    rehydrateLiveSessionStatuses(snapshot(), Date.now(), 'personal')

    expect($sessionStates.get()['rt-8'].busy).toBe(true)
    // The registry is per profile too, or the same empty snapshot would darken
    // the other gateway's rows.
    expect($workingSessionIds.get().has('stored-8')).toBe(true)
  })

  it('forgets its bookkeeping on a gateway wipe', () => {
    rehydrateLiveSessionStatuses(snapshot({ id: 'rt-9', session_key: 'stored-9', status: 'working' }))
    resetLiveRuntimeTracking()

    // A fresh backend re-seeds silently; nothing carried over may reap.
    seed('rt-9', { busy: true, runtimeSessionId: 'rt-9', storedSessionId: 'stored-9' })
    rehydrateLiveSessionStatuses(snapshot())

    expect($sessionStates.get()['rt-9'].busy).toBe(true)
  })
})

describe('startLiveSessionSync', () => {
  let stop: () => void = () => {}

  beforeEach(() => {
    vi.useFakeTimers()
    resetLiveSync()
    $gatewayState.set('closed')
    vi.mocked(requestGateway).mockClear()
    vi.mocked(listAllProfileSessions).mockClear()
    stop = startLiveSessionSync()
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('reseeds BOTH the liveness snapshot and the stored lists when the socket comes back', async () => {
    // The reconnect hole this closes: nothing in universal refreshed the session
    // list on gateway open, and a broadcast that landed while the socket was
    // down is never replayed — so the sidebar kept whatever it held at the drop.
    $gatewayState.set('open')
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toContain('session.active_list')
    expect(listAllProfileSessions).toHaveBeenCalled()
  })

  it('coalesces a burst of sessions.changed into ONE stored-list refresh', async () => {
    $changeEventsAvailable.set(true)
    $gatewayState.set('open')
    await vi.advanceTimersByTimeAsync(0)

    const afterConnect = vi.mocked(listAllProfileSessions).mock.calls.length

    // A streaming turn writes state.db continuously; the watcher floors the
    // broadcast to 2s, which is still far faster than a 100-row list fetch.
    for (let i = 0; i < 5; i++) {
      $sessionsChangeTick.set($sessionsChangeTick.get() + 1)
    }

    await vi.advanceTimersByTimeAsync(0)

    expect(vi.mocked(listAllProfileSessions).mock.calls.length).toBe(afterConnect)

    await vi.advanceTimersByTimeAsync(SESSIONS_LIST_TICK_GAP_MS)

    // Trailing edge: exactly one refresh, carrying the burst's LAST write.
    expect(vi.mocked(listAllProfileSessions).mock.calls.length).toBe(afterConnect + 2)
  })

  it('leaves the stored-list refresh to the surfaces own polls on a gateway that never broadcasts', async () => {
    $gatewayState.set('open')
    await vi.advanceTimersByTimeAsync(0)

    const afterConnect = vi.mocked(listAllProfileSessions).mock.calls.length

    $sessionsChangeTick.set($sessionsChangeTick.get() + 1)
    await vi.advanceTimersByTimeAsync(SESSIONS_LIST_TICK_GAP_MS * 2)

    expect(vi.mocked(listAllProfileSessions).mock.calls.length).toBe(afterConnect)
  })

  it('is idempotent, so a shell remount cannot leave two pollers running', () => {
    const second = startLiveSessionSync()

    $gatewayState.set('open')

    const pulls = vi.mocked(requestGateway).mock.calls.filter(call => call[0] === 'session.active_list').length

    second()

    expect(pulls).toBe(1)
  })
})
