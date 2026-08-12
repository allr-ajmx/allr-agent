import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type * as WindowsStore from '@/store/windows'
import type { SessionInfo } from '@/types/hermes'

// `vi.hoisted`: store/session calls `ownsPersistedAppState()` at import time, so
// the factories below run before a plain `const` would be initialised.
const { getOne, ownsState, patch } = vi.hoisted(() => ({
  ownsState: vi.fn(() => true),
  patch: vi.fn<(id: string, pinned: boolean, profile?: null | string) => Promise<{ ok: boolean }>>(() =>
    Promise.resolve({ ok: true })
  ),
  getOne: vi.fn<(id: string, profile?: null | string) => Promise<unknown>>(() => Promise.resolve({ id: 'x' }))
}))

// Partial mocks: store/session reaches the rest of the REST surface through
// `@/hermes` (store/profiles calls setApiRequestProfile at import) and reads
// other window helpers, so only the two seams under test are replaced.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  setSessionPinnedRemote: (id: string, pinned: boolean, profile?: null | string) => patch(id, pinned, profile),
  getSession: (id: string, profile?: null | string) => getOne(id, profile)
}))

vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsStore>()),
  ownsPersistedAppState: () => ownsState()
}))

import { ApiError } from '@/lib/api'
import { $pinnedSessionIds } from '@/store/layout'
import { $pinnedSessionCache, $sessions, $sessionsListEpoch } from '@/store/session'

import { resetSessionPinMirror, watchSessionPins } from './session-pin-sync'

const row = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, message_count: 1, source: 'cli', started_at: 0, title: id, ...extra }) as SessionInfo

const flush = () => Promise.resolve()

beforeAll(() => {
  // Attach the listeners once — module state is process-global.
  watchSessionPins()
})

beforeEach(() => {
  ownsState.mockReturnValue(true)
  getOne.mockReset()
  getOne.mockResolvedValue({ id: 'x' })
  $sessions.set([])
  $pinnedSessionCache.set({})
  $pinnedSessionIds.set([])
  // The mirror/pending/unconfirmed maps are module-global, so one test's
  // bookkeeping would otherwise suppress the next test's PATCH (or fence out
  // its page). Same reset the gateway switch uses.
  resetSessionPinMirror()
  patch.mockClear()
})

afterEach(() => {
  $sessions.set([])
  $pinnedSessionIds.set([])
})

describe('watchSessionPins', () => {
  it('mirrors a new pin as pinned=true with the row profile', async () => {
    $sessions.set([row('a', { profile: 'work' })])
    $pinnedSessionIds.set(['a'])
    await flush()

    expect(patch).toHaveBeenCalledWith('a', true, 'work')
  })

  it('mirrors an unpin as pinned=false', async () => {
    $sessions.set([row('b')])
    $pinnedSessionIds.set(['b'])
    await flush()
    patch.mockClear()

    $pinnedSessionIds.set([])
    await flush()

    expect(patch).toHaveBeenCalledWith('b', false, undefined)
  })

  it('defers a pin whose row is not loaded, then flushes once it appears', async () => {
    $pinnedSessionIds.set(['c'])
    await flush()
    // No row yet -> nothing sent.
    expect(patch).not.toHaveBeenCalled()

    $sessions.set([row('c', { profile: 'p2' })])
    await flush()

    expect(patch).toHaveBeenCalledWith('c', true, 'p2')
  })

  it('matches a pin id against the lineage root', async () => {
    // pin id is the lineage root; the live row carries it as _lineage_root_id.
    $sessions.set([row('tip', { _lineage_root_id: 'root' })])
    $pinnedSessionIds.set(['root'])
    await flush()

    expect(patch).toHaveBeenCalledWith('root', true, undefined)
  })

  it('does not re-PATCH an already-mirrored pin on unrelated session updates', async () => {
    $sessions.set([row('d')])
    $pinnedSessionIds.set(['d'])
    await flush()
    patch.mockClear()

    // A session-list refresh that doesn't change the pinned set.
    $sessions.set([row('d'), row('e')])
    await flush()

    expect(patch).not.toHaveBeenCalled()
  })

  // Satellite/activity windows share this origin's localStorage. Two windows
  // authoring the same persisted set would double every PATCH and let a
  // background window adopt rows on the primary's behalf.
  it('does nothing in a window that does not own persisted app state', async () => {
    ownsState.mockReturnValue(false)

    $sessions.set([row('sat', { pinned: true })])
    $pinnedSessionIds.set(['other'])
    await flush()

    expect(patch).not.toHaveBeenCalled()
    expect($pinnedSessionIds.get()).toEqual(['other'])
  })

  // The mirror is per-backend: the next gateway's state.db has never seen these
  // pins, so the bookkeeping that says "already pushed" has to go with it.
  it('re-asserts the whole set after resetSessionPinMirror', async () => {
    $sessions.set([row('kept', { profile: 'work' })])
    $pinnedSessionIds.set(['kept'])
    await flush()
    patch.mockClear()

    resetSessionPinMirror()
    // A list landing on the new backend is what re-triggers the reconcile.
    $sessions.set([row('kept', { profile: 'work' })])
    await flush()

    expect(patch).toHaveBeenCalledWith('kept', true, 'work')
  })
})

describe('watchSessionPins remote pull', () => {
  it('adopts a pin another app made', async () => {
    $sessions.set([row('remote', { pinned: true })])
    await flush()

    expect($pinnedSessionIds.get()).toContain('remote')
  })

  it('adopts a remote pin on the durable lineage root, not the live tip', async () => {
    $sessions.set([row('tip', { _lineage_root_id: 'root', pinned: true })])
    await flush()

    expect($pinnedSessionIds.get()).toEqual(['root'])
  })

  it('does not echo an adopted pin back as a redundant write', async () => {
    $sessions.set([row('adopted', { pinned: true })])
    await flush()

    expect(patch).not.toHaveBeenCalled()
  })

  it('drops a local pin the server reports as unpinned', async () => {
    $pinnedSessionIds.set(['gone'])
    $sessions.set([row('gone', { pinned: true })])
    await flush()
    patch.mockClear()

    // Another app unpinned it; our next refresh carries the new truth.
    $sessions.set([row('gone', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).not.toContain('gone')
  })

  it('leaves the local set alone when the backend omits the flag', async () => {
    // Settle the pin FIRST — mirrored, and confirmed by a page that echoes our
    // value back — so the write guard is released and cannot be what saves the
    // pin below. Asserting on an unsettled pin passes with the `undefined`
    // check deleted, because `unconfirmed` fences the row either way.
    $pinnedSessionIds.set(['legacy'])
    $sessions.set([row('legacy', { pinned: true })])
    await flush()
    await flush()
    expect($pinnedSessionIds.get()).toContain('legacy')

    // Now a page with no `pinned` key at all — a runtime predating the column.
    // "No opinion" is not "unpinned": acting on it would drop the pin.
    $sessions.set([row('legacy')])
    await flush()

    expect($pinnedSessionIds.get()).toContain('legacy')
  })

  it('does not revert a fresh local pin while the loaded row is still stale', async () => {
    // The row is already loaded and says pinned=false when the user pins.
    // The pin listener fires reconcile synchronously — before any PATCH — and
    // the stale row must not win over the local intent.
    $sessions.set([row('fresh', { pinned: false })])
    await flush()
    patch.mockClear()

    $pinnedSessionIds.set(['fresh'])
    await flush()

    expect($pinnedSessionIds.get()).toContain('fresh')
    expect(patch).toHaveBeenCalledWith('fresh', true, undefined)
  })

  it('does not revert a fresh local unpin while the loaded row still says pinned', async () => {
    // Adopt a server-side pin first, so it's held locally and mirrored.
    $sessions.set([row('sticky', { pinned: true })])
    await flush()
    expect($pinnedSessionIds.get()).toContain('sticky')
    patch.mockClear()

    // User unpins while the loaded row still says pinned=true.
    $pinnedSessionIds.set([])
    await flush()

    expect($pinnedSessionIds.get()).not.toContain('sticky')
    expect(patch).toHaveBeenCalledWith('sticky', false, undefined)
  })

  it('keeps a deferred pin (row not yet loaded) when a stale page finally arrives', async () => {
    $pinnedSessionIds.set(['deferred'])
    await flush()
    expect(patch).not.toHaveBeenCalled()

    // The page that loads the row still predates our intent.
    $sessions.set([row('deferred', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain('deferred')
    expect(patch).toHaveBeenCalledWith('deferred', true, undefined)
  })

  it('ignores a stale page that contradicts a write still in flight', async () => {
    let settle: (v: { ok: boolean }) => void = () => {}

    patch.mockImplementationOnce(() => new Promise(resolve => (settle = resolve)))

    $sessions.set([row('race')])
    $pinnedSessionIds.set(['race'])
    await flush()
    expect(patch).toHaveBeenCalledWith('race', true, undefined)

    // A list request issued before the PATCH lands still says pinned=false.
    // Honouring it would silently undo the pin the user just made.
    $sessions.set([row('race', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain('race')

    settle({ ok: true })
    await flush()
    await flush()

    expect($pinnedSessionIds.get()).toContain('race')
  })

  it('still ignores a pre-write page that lands AFTER the ack', async () => {
    // The ack is not proof: a list request issued before the PATCH is slower
    // than the PATCH itself, so it can arrive afterwards still carrying the
    // old value. Reverting on it un-pins the session AND pushes the wrong
    // value back to the server, making the mistake durable.
    $sessions.set([row('acked')])
    $pinnedSessionIds.set(['acked'])
    await flush()
    await flush()
    expect(patch).toHaveBeenCalledWith('acked', true, undefined)
    patch.mockClear()

    // Post-ack, but this page predates the write.
    $sessions.set([row('acked', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain('acked')
    expect(patch).not.toHaveBeenCalled()
  })

  it('releases the guard once a page confirms the written value', async () => {
    $sessions.set([row('confirmed')])
    $pinnedSessionIds.set(['confirmed'])
    await flush()
    await flush()

    // The server catches up and echoes our value back.
    $sessions.set([row('confirmed', { pinned: true })])
    await flush()
    patch.mockClear()

    // With the write confirmed, a genuine remote unpin is authoritative again.
    $sessions.set([row('confirmed', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).not.toContain('confirmed')
  })

  it('stops fencing once the guard cooldown expires', async () => {
    vi.useFakeTimers()

    try {
      $sessions.set([row('stale')])
      $pinnedSessionIds.set(['stale'])
      await flush()
      await flush()

      // No page ever confirms the write. The guard must not fence forever —
      // after the cooldown the server's answer wins again.
      vi.advanceTimersByTime(11_000)

      $sessions.set([row('stale', { pinned: false })])
      await flush()

      expect($pinnedSessionIds.get()).not.toContain('stale')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the pin and retries when the write itself fails', async () => {
    patch.mockImplementationOnce(() => Promise.reject(new Error('offline')))

    $sessions.set([row('failed')])
    $pinnedSessionIds.set(['failed'])
    await flush()
    await flush()
    patch.mockClear()

    // The PATCH never landed, so the server legitimately still says unpinned —
    // but that's OUR undelivered intent, not a remote decision. The pin stays
    // and the next reconcile retries it rather than silently dropping it.
    $sessions.set([row('failed', { pinned: false })])
    await flush()

    expect($pinnedSessionIds.get()).toContain('failed')
    expect(patch).toHaveBeenCalledWith('failed', true, undefined)
  })
})

// MJXHRM-414's remaining half: a session deleted on ANOTHER client. Nothing in
// any page says `pinned: false` about a row that no longer exists, so the pull
// above cannot see it — the pin survives, `$pinnedSessionCache` keeps serving
// its last-known row, and the Pinned section shows a chat that is gone. Absence
// from a page is not the signal (an archived pin is absent too); a by-id 404 is.
describe('watchSessionPins ghost sweep', () => {
  const notFound = () => new ApiError('GET /api/sessions/x → HTTP 404: nope', 404, 'nope')

  /** A pin whose row only the cache still has — the ghost shape. */
  const seedCacheOnlyPin = (id: string) => {
    $pinnedSessionIds.set([id])
    $pinnedSessionCache.set({ [id]: row(id) })
  }

  /** A full window landing is the only moment absence carries information. */
  const listLanded = async () => {
    $sessionsListEpoch.set($sessionsListEpoch.get() + 1)
    await flush()
    await flush()
    await flush()
  }

  it('releases the pin of a session every backend says is gone', async () => {
    seedCacheOnlyPin('deleted-elsewhere')
    getOne.mockRejectedValue(notFound())

    await listLanded()

    expect(getOne).toHaveBeenCalledWith('deleted-elsewhere', undefined)
    expect($pinnedSessionIds.get()).toEqual([])
    // The cached row goes with the pin, or the section would still resolve it.
    expect($pinnedSessionCache.get()['deleted-elsewhere']).toBeUndefined()
  })

  it('does not PATCH the row it just proved is gone', async () => {
    seedCacheOnlyPin('deleted-elsewhere')
    getOne.mockRejectedValue(notFound())
    patch.mockClear()

    await listLanded()

    expect(patch).not.toHaveBeenCalled()
  })

  // The case that makes the naive heuristic dangerous: an archived session is
  // absent from the page too, because the backend's `include_pinned` back-fill
  // obeys the archived filter. Unpinning on absence would drop the pin of every
  // archived-but-pinned chat.
  it('keeps a pin the list omits but a by-id read still resolves', async () => {
    seedCacheOnlyPin('archived-pin')
    getOne.mockResolvedValue({ id: 'archived-pin', archived: true })

    await listLanded()

    expect($pinnedSessionIds.get()).toEqual(['archived-pin'])
  })

  // A dead gateway answers nothing. Reading that as a deletion would destroy
  // user state over a dropped packet.
  it('keeps the pin when the probe gets no answer at all', async () => {
    seedCacheOnlyPin('unreachable')
    getOne.mockRejectedValue(new Error('network down'))

    await listLanded()

    expect($pinnedSessionIds.get()).toEqual(['unreachable'])
  })

  it('re-probes an unanswered pin on the next refresh, rather than trusting a cooldown it never earned', async () => {
    seedCacheOnlyPin('unreachable')
    getOne.mockRejectedValue(new Error('network down'))
    await listLanded()
    getOne.mockClear()

    // The gateway is back, and now it answers.
    getOne.mockRejectedValue(notFound())
    await listLanded()

    expect(getOne).toHaveBeenCalled()
    expect($pinnedSessionIds.get()).toEqual([])
  })

  it('asks once per pin, not once per refresh', async () => {
    seedCacheOnlyPin('archived-pin')
    getOne.mockResolvedValue({ id: 'archived-pin' })
    await listLanded()
    expect(getOne).toHaveBeenCalledTimes(1)

    await listLanded()
    await listLanded()

    expect(getOne).toHaveBeenCalledTimes(1)
  })

  // After a gateway switch the cache is wiped and the pin ids stay — they are
  // this app's mirror of the OTHER backend's durable flag. Probing them here
  // would 404 against a gateway that has simply never heard of them and delete
  // the user's pins on the gateway they came from.
  it('never probes a pin that has no cached row to render', async () => {
    $pinnedSessionIds.set(['other-gateways-pin'])
    getOne.mockRejectedValue(notFound())

    await listLanded()

    expect(getOne).not.toHaveBeenCalled()
    expect($pinnedSessionIds.get()).toEqual(['other-gateways-pin'])
  })

  it('leaves a pin alone while its row is loaded', async () => {
    $pinnedSessionIds.set(['live'])
    $sessions.set([row('live')])
    $pinnedSessionCache.set({ live: row('live') })
    getOne.mockRejectedValue(notFound())

    await listLanded()

    expect(getOne).not.toHaveBeenCalled()
    expect($pinnedSessionIds.get()).toEqual(['live'])
  })

  // A row loaded under its live tip id answers for a pin stored on the durable
  // lineage root — otherwise a compacted chat's pin is probed (and, if the probe
  // ever answered wrongly, dropped) on every refresh.
  it('counts a loaded row under its lineage-root pin id', async () => {
    $pinnedSessionIds.set(['root'])
    $sessions.set([row('tip', { _lineage_root_id: 'root' })])
    $pinnedSessionCache.set({ root: row('tip', { _lineage_root_id: 'root' }) })
    getOne.mockRejectedValue(notFound())

    await listLanded()

    expect(getOne).not.toHaveBeenCalled()
    expect($pinnedSessionIds.get()).toEqual(['root'])
  })

  it('does nothing in a window that does not own persisted app state', async () => {
    seedCacheOnlyPin('deleted-elsewhere')
    getOne.mockRejectedValue(notFound())
    ownsState.mockReturnValue(false)

    await listLanded()

    expect(getOne).not.toHaveBeenCalled()
    expect($pinnedSessionIds.get()).toEqual(['deleted-elsewhere'])
  })
})
