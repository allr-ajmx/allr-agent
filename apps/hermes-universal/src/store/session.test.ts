import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  listAllProfileSessions: vi.fn(),
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  setSessionArchived: vi.fn(),
  searchSessions: vi.fn(),
  setApiRequestProfile: vi.fn()
}))
// `$gatewayState` and `getGatewayClient` are here only because `store/projects`
// reaches `store/connection` through `lib/api`, and `branchStoredSession` now
// resolves its parent through `store/session-lookup` (which reads the project
// tree). Omitting either makes the whole suite fail to import, not one test.
vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $gatewayState: atom('open'),
    addGatewayEventListener: () => () => {},
    getGatewayClient: () => null,
    requestGateway: vi.fn()
  }
})

import { deleteSession, getSession, getSessionMessages, listAllProfileSessions, renameSession } from '@/hermes'
import { ApiError } from '@/lib/api'
import { $busy, $currentCwd, $messages, $sessionId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { $showAllProfiles } from '@/store/profile'
import { $activeProfile } from '@/store/profiles'
import { $sessionStates, hydratingKey, updateSession } from '@/store/session-state-types'
import { clearAllTurns, getInflightTurn } from '@/store/turn-lifecycle'
import { resetSessionStates, seedActiveSession, seedSession } from '@/test-sessions'
import type { PaginatedSessions, SessionInfo } from '@/types/hermes'

import { $pinnedSessionIds } from './layout'
import { $profiles } from './profiles'
import { $projectTree } from './projects'
import {
  $activeStoredSessionId,
  $pinnedSessionCache,
  $removedSessionIds,
  $sessions,
  $sessionsLimit,
  $sessionsListEpoch,
  $sessionsTotal,
  $unreadFinishedSessionIds,
  $workingSessionIds,
  archiveSessionLocal,
  branchCurrentSession,
  branchStoredSession,
  clearPinnedSessionCache,
  clearUnreadFinishedSession,
  deleteSessionLocal,
  isMessagingSource,
  knownSessionProfile,
  loadMoreSessions,
  messagingSourceLabel,
  openSession,
  pinnedSessionRows,
  pruneSessionTombstones,
  reclaimSessionTransport,
  refreshSessions,
  renameSessionLocal,
  resetSessionsPaging,
  resolveSessionProfile,
  sameStoredSession,
  sessionExistsOnBackends,
  setBranchedSessionOpener
} from './session'

const row = (id: string, title: string): SessionInfo => ({ id, title }) as unknown as SessionInfo

/** One project holding `sessions` in a single lane — the widest source
 *  `sessionRowFor` searches, and the one a session past the recents page is
 *  usually found in. */
const treeWith = (sessions: SessionInfo[]) =>
  ({
    id: 'p1',
    label: 'Project',
    path: '/repo',
    previewSessions: [],
    repos: [
      {
        id: 'r1',
        label: 'repo',
        path: '/repo',
        groups: [{ id: 'g1', label: 'main', path: '/repo', sessions }],
        sessionCount: sessions.length
      }
    ],
    sessionCount: sessions.length
  }) as unknown as (typeof $projectTree.value)[number]

const rowWithCwd = (id: string, cwd: null | string): SessionInfo => ({ id, cwd }) as unknown as SessionInfo

const rowOnProfile = (id: string, profile: string): SessionInfo => ({ id, profile }) as unknown as SessionInfo

const profile = (name: string) => ({ name }) as unknown as (typeof $profiles.value)[number]

afterEach(() => {
  vi.clearAllMocks()
  $sessions.set([])
  $sessionsTotal.set(0)
  $activeStoredSessionId.set(null)
  $unreadFinishedSessionIds.set([])
  $showAllProfiles.set(false)
  $activeProfile.set(null)
  $profiles.set([])
  $removedSessionIds.set(new Set())
  $pinnedSessionIds.set([])
  setBranchedSessionOpener(null)
  resetSessionsPaging()
  clearAllTurns()
  resetSessionStates()
  seedActiveSession('runtime-0')
})

describe('session store', () => {
  it('deleteSessionLocal removes optimistically and rolls back on error', async () => {
    $sessions.set([row('a', 'A'), row('b', 'B')])
    $sessionsTotal.set(2)
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })
    await deleteSessionLocal('a')
    expect($sessions.get().map(s => s.id)).toEqual(['b'])
    expect($sessionsTotal.get()).toBe(1)

    $sessions.set([row('a', 'A')])
    vi.mocked(deleteSession).mockRejectedValue(new Error('nope'))
    await deleteSessionLocal('a')
    expect($sessions.get().map(s => s.id)).toEqual(['a']) // restored
  })

  it('renameSessionLocal updates optimistically and rolls back on error', async () => {
    $sessions.set([row('a', 'Old')])
    vi.mocked(renameSession).mockRejectedValue(new Error('nope'))
    await renameSessionLocal('a', 'New')
    expect($sessions.get()[0].title).toBe('Old') // rolled back
  })

  it('openSession resumes: hydrates the transcript + binds the runtime id', async () => {
    vi.mocked(requestGateway).mockResolvedValue({
      messages: [{ role: 'user', content: 'hi' }],
      session_id: 'runtime-1'
    })
    await openSession('stored-9')
    expect(requestGateway).toHaveBeenCalledWith('session.resume', { session_id: 'stored-9', cols: 96 })
    expect($activeStoredSessionId.get()).toBe('stored-9')
    expect($sessionId.get()).toBe('runtime-1')
    expect($busy.get()).toBe(false)
    expect($messages.get()).toEqual([{ id: expect.any(String), role: 'user', parts: [{ type: 'text', text: 'hi' }] }])
  })

  // The tile delegate has adopted a resumed turn since MJXHRM-356; the PRIMARY
  // chat never did, so the surface most likely to be holding a live turn was the
  // one `reconcileInflightTurns` could not see on a reconnect.
  it('openSession adopts a turn already running on the gateway', async () => {
    vi.mocked(requestGateway).mockResolvedValue({
      messages: [],
      session_id: 'runtime-1',
      running: true,
      inflight: { user: 'the running prompt', assistant: 'partial', streaming: true }
    })

    await openSession('stored-9')

    expect(getInflightTurn('runtime-1')).toMatchObject({ origin: 'remote', prompt: 'the running prompt' })
    expect($busy.get()).toBe(true)
  })

  // A cold resume after a crash reports `running: false, status: "idle"` while
  // its kickoff thread waits on a deferred agent build; the interrupted prompt
  // comes back on `inflight`, filled from the crash marker.
  it('openSession adopts the crash continuation the gateway scheduled', async () => {
    vi.mocked(requestGateway).mockResolvedValue({
      messages: [],
      session_id: 'runtime-1',
      running: false,
      auto_continue: { attempt: 1, interrupted_at: 1_000 },
      inflight: { user: 'fix the flaky test', assistant: '', streaming: true }
    })

    await openSession('stored-9')

    expect(getInflightTurn('runtime-1')).toMatchObject({
      origin: 'auto-continue',
      prompt: 'fix the flaky test',
      attempts: 1
    })
    // Busy, so the recovered crash-journal tail stays pending instead of being
    // sealed as a finished reply seconds before `message.start` lands.
    expect($busy.get()).toBe(true)
  })

  it('openSession leaves an idle session with no turn record', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-1', running: false })

    await openSession('stored-9')

    expect(getInflightTurn('runtime-1')).toBeNull()
    expect($busy.get()).toBe(false)
  })

  it('openSession restores the chat cwd from the stored row', async () => {
    $sessions.set([rowWithCwd('stored-9', '/home/me/project-a')])
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-1' })
    await openSession('stored-9')
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })

  it('openSession prefers the resume response runtime cwd over the stored row', async () => {
    $sessions.set([rowWithCwd('stored-9', '/home/me/stale')])
    vi.mocked(requestGateway).mockResolvedValue({
      info: { cwd: '/home/me/project-b' },
      messages: [],
      session_id: 'runtime-1'
    })
    await openSession('stored-9')
    expect($currentCwd.get()).toBe('/home/me/project-b')
  })

  it('openSession keeps the stored cwd when the resume response omits one', async () => {
    $sessions.set([rowWithCwd('stored-9', '/home/me/project-a')])
    vi.mocked(requestGateway).mockResolvedValue({ info: {}, messages: [], session_id: 'runtime-1' })
    await openSession('stored-9')
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })

  it('openSession detaches the cwd for a chat that has none', async () => {
    seedActiveSession('runtime-prev', { cwd: '/home/me/previous-chat' })
    $sessions.set([rowWithCwd('stored-9', null)])
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-1' })
    await openSession('stored-9')
    expect($currentCwd.get()).toBe('')
  })

  it('openSession still restores the cwd when resume fails', async () => {
    $sessions.set([rowWithCwd('stored-9', '/home/me/project-a')])
    vi.mocked(requestGateway).mockRejectedValue(new Error('offline'))
    await openSession('stored-9')
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })
})

/**
 * MJXHRM-385. A hydrate seeds `hydrating:<stored>` with `busy: true`, and the
 * generation counter is what cancels one open when another supersedes it. The
 * two together used to leave the abandoned placeholder busy FOREVER: nothing
 * else ever writes that slice, the LRU refuses to evict a busy placeholder, and
 * every surface keyed by the stored id — the sidebar row's status dot and its
 * running arc above all — then reads a turn that was never running.
 */
describe('openSession — an abandoned hydrate', () => {
  /** A resume that hangs until the returned `release` is called. */
  const pendingResume = (sessionId: string) => {
    let release = () => {}

    vi.mocked(getSessionMessages).mockResolvedValue({ messages: [], session_id: sessionId } as never)
    vi.mocked(requestGateway).mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ messages: [], session_id: `runtime-${sessionId}` })
        }) as never
    )

    return () => release()
  }

  // `onResumeSession` calls `openSession` on EVERY row click with no
  // already-active guard, so this is one row clicked twice during its own load.
  it('is not cancelled by a second open of the same session', async () => {
    const release = pendingResume('stored-9')

    const opening = openSession('stored-9')
    // The same row again, while the first open is still in flight.
    openSession('stored-9')
    release()
    await opening

    expect($sessionStates.get()[hydratingKey('stored-9')]).toBeUndefined()
    expect($sessionStates.get()['runtime-stored-9']).toMatchObject({
      busy: false,
      runtimeSessionId: 'runtime-stored-9'
    })
    expect($workingSessionIds.get().has('stored-9')).toBe(false)
  })

  // Superseded for real: a DIFFERENT session was opened mid-load. The first
  // one's placeholder has no runtime binding and no turn — it must not be left
  // claiming one.
  it('leaves no busy placeholder behind when another session supersedes it', async () => {
    const release = pendingResume('stored-9')

    const opening = openSession('stored-9')
    // A different row, before the first resume lands.
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-other' })
    void openSession('stored-other')
    release()
    await opening

    expect($sessionStates.get()[hydratingKey('stored-9')]).toBeUndefined()
    expect($workingSessionIds.get().has('stored-9')).toBe(false)
  })
})

/**
 * MJXHRM-371. The warm short-circuit is what makes switching mid-turn lossless
 * (MJX-132) — and it is also what leaves the gateway TRANSPORT bound to whatever
 * webview last resumed the session. `forceResume` separates the two: a caller
 * that needs the stream back can ask for a resume without asking for a reload.
 */
describe('openSession — forceResume', () => {
  const warmSession = () => {
    seedActiveSession('runtime-warm', { storedSessionId: 'stored-warm', messages: [] })
    // Leave the pointer elsewhere so the warm promotion has work to do.
    $activeStoredSessionId.set(null)
  }

  it('issues NO resume on a warm slice by default', async () => {
    warmSession()

    await openSession('stored-warm')

    expect(requestGateway).not.toHaveBeenCalled()
    expect($activeStoredSessionId.get()).toBe('stored-warm')
  })

  it('issues exactly one resume on a warm slice when asked', async () => {
    warmSession()
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-warm' })

    await openSession('stored-warm', { forceResume: true })

    expect(requestGateway).toHaveBeenCalledTimes(1)
    expect(requestGateway).toHaveBeenCalledWith('session.resume', { session_id: 'stored-warm', cols: 96 })
    expect($activeStoredSessionId.get()).toBe('stored-warm')
  })

  it('does not refetch the transcript or overwrite the warm one', async () => {
    seedActiveSession('runtime-warm', {
      storedSessionId: 'stored-warm',
      messages: [{ id: 'kept', role: 'user', parts: [{ type: 'text', text: 'still here' }] }]
    })
    // A display-REDUCED resume payload — writing it would be the MJX-132 loss.
    vi.mocked(requestGateway).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'reduced' }],
      session_id: 'runtime-warm'
    })

    await openSession('stored-warm', { forceResume: true })

    expect(getSessionMessages).not.toHaveBeenCalled()
    expect($messages.get().map(m => m.id)).toEqual(['kept'])
  })

  it('re-keys the slice when the backend hands back a new runtime id', async () => {
    warmSession()
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-compacted' })

    await openSession('stored-warm', { forceResume: true })

    expect($sessionId.get()).toBe('runtime-compacted')
    expect($activeStoredSessionId.get()).toBe('stored-warm')
  })

  it('leaves the chat readable when the rebind fails', async () => {
    seedActiveSession('runtime-warm', {
      storedSessionId: 'stored-warm',
      messages: [{ id: 'kept', role: 'user', parts: [{ type: 'text', text: 'still here' }] }]
    })
    vi.mocked(requestGateway).mockRejectedValue(new Error('offline'))

    await openSession('stored-warm', { forceResume: true })

    expect($messages.get().map(m => m.id)).toEqual(['kept'])
    expect($activeStoredSessionId.get()).toBe('stored-warm')
  })
})

// The BACKGROUND half of the same seam (MJXHRM-371): a pop-out window closed and
// its session has to come back onto this socket — while the user goes on looking
// at whatever they were looking at.
describe('reclaimSessionTransport', () => {
  it('rebinds the stream without moving what the window is showing', async () => {
    // Looking at one chat; a pop-out was holding a different one.
    seedActiveSession('runtime-here', { storedSessionId: 'stored-here' })
    $activeStoredSessionId.set('stored-here')
    seedSession('runtime-popped', { storedSessionId: 'stored-popped' })
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-popped' })

    await reclaimSessionTransport('stored-popped')

    expect(requestGateway).toHaveBeenCalledWith('session.resume', { session_id: 'stored-popped', cols: 96 })
    // The pane never moves. `openSession(…, { forceResume: true })` would have
    // dragged it onto a conversation the user closed a window on.
    expect($activeStoredSessionId.get()).toBe('stored-here')
    expect($sessionId.get()).toBe('runtime-here')
  })

  it('re-keys the reclaimed slice without stealing the active key', async () => {
    seedActiveSession('runtime-here', { storedSessionId: 'stored-here' })
    $activeStoredSessionId.set('stored-here')
    seedSession('runtime-popped', { storedSessionId: 'stored-popped' })
    // Compacted while the other window held it.
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-compacted' })

    await reclaimSessionTransport('stored-popped')

    expect($sessionStates.get()['runtime-compacted']?.storedSessionId).toBe('stored-popped')
    expect($sessionStates.get()['runtime-popped']).toBeUndefined()
    // NOT the reclaimed session's new id — that is the bug this guards.
    expect($sessionId.get()).toBe('runtime-here')
  })

  it('does nothing for a session with no live slice here', async () => {
    // Nothing on screen is deaf, and the next open hydrates it cold — which
    // resumes and binds properly on its own.
    await reclaimSessionTransport('stored-never-seen')

    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('stands aside while a hydrate is already in flight', async () => {
    seedSession(hydratingKey('stored-popped'), { storedSessionId: 'stored-popped' })

    await reclaimSessionTransport('stored-popped')

    // That hydrate issues its own resume; a second one would race its re-key and
    // strand the slice under a dead placeholder.
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('is not cancelled by an unrelated session being opened', async () => {
    seedSession('runtime-popped', { storedSessionId: 'stored-popped' })
    // Two profiles, so the owner has to be PROBED — the await that puts a real
    // gap between entering the reclaim and issuing its resume. Without one the
    // open cannot interleave early enough to test anything, and this passed with
    // the generation guard still in place.
    $profiles.set([profile('default'), profile('work')])

    let resolveProbe = () => {}
    vi.mocked(getSession).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveProbe = () => resolve({ id: 'stored-popped', profile: 'default' } as SessionInfo)
        })
    )
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-popped' })

    const reclaiming = reclaimSessionTransport('stored-popped')

    // The user switches chats mid-reclaim. The generation counter answers "is
    // this still the chat being switched to", which a background rebind is not
    // asking — bumping it must not silently skip the resume.
    seedSession('runtime-other', { storedSessionId: 'stored-other' })
    openSession('stored-other')
    resolveProbe()
    await reclaiming

    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-popped',
      cols: 96,
      profile: 'default'
    })
  })

  it('drops a re-key whose slice vanished while the resume was in flight', async () => {
    seedSession('runtime-popped', { storedSessionId: 'stored-popped' })

    let release = () => {}
    vi.mocked(requestGateway).mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ messages: [], session_id: 'runtime-compacted' })
        }) as never
    )

    const reclaiming = reclaimSessionTransport('stored-popped')

    // Deleted, evicted, or re-keyed by a hydrate that raced us. `rekeySession`
    // would move an EMPTY state onto the new runtime id and leave a ghost.
    $sessionStates.set({})
    release()
    await reclaiming

    expect($sessionStates.get()['runtime-compacted']).toBeUndefined()
  })
})

// A session-scoped call is served by ONE profile's backend. Without the owner it
// lands on whichever gateway is live, which resumes another profile's chat
// against the wrong database.
describe('owning profile', () => {
  it('routes resume + transcript through the row own profile stamp', async () => {
    $sessions.set([rowOnProfile('stored-9', 'work')])
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-1' })
    vi.mocked(getSessionMessages).mockResolvedValue({ messages: [], session_id: 'stored-9' } as never)

    await openSession('stored-9')

    expect(getSessionMessages).toHaveBeenCalledWith('stored-9', 'work')
    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-9',
      cols: 96,
      profile: 'work'
    })
  })

  it('scopes delete + archive to the owning profile', async () => {
    $sessions.set([rowOnProfile('a', 'work')])
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })
    await deleteSessionLocal('a')
    expect(deleteSession).toHaveBeenCalledWith('a', 'work')

    $sessions.set([rowOnProfile('b', 'work')])
    await archiveSessionLocal('b')
    expect(vi.mocked(getSession).mock.calls.length).toBe(0)
  })

  it('never probes when there is only one profile to be on', async () => {
    // A single-profile install has no wrong answer to route around, so the
    // resume must stay synchronous rather than pay a by-id lookup first.
    await expect(resolveSessionProfile('unknown')).resolves.toBeUndefined()
    expect(getSession).not.toHaveBeenCalled()
  })

  it('probes other profiles for a session outside the loaded rows', async () => {
    $profiles.set([profile('default'), profile('work')])
    vi.mocked(getSession)
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({ id: 'stored-9', profile: 'work' } as SessionInfo)

    await expect(resolveSessionProfile('stored-9')).resolves.toBe('work')
    // Resolved once, remembered forever — a session's owner never changes.
    expect(knownSessionProfile('stored-9')).toBe('work')
  })
})

// The positive deletion signal behind the ghost-pin sweep (MJXHRM-414). Absence
// from a list proves nothing — an archived session is absent too — so the only
// safe answer comes from asking about the id directly.
describe('sessionExistsOnBackends', () => {
  const notFound = () => new ApiError('GET /api/sessions/x → HTTP 404: nope', 404, 'nope')

  it('reports a row the backend still serves as present', async () => {
    vi.mocked(getSession).mockResolvedValue({ id: 'alive' } as SessionInfo)

    await expect(sessionExistsOnBackends('alive')).resolves.toBe('present')
  })

  it('reports gone only when the backend answers 404', async () => {
    vi.mocked(getSession).mockRejectedValue(notFound())

    await expect(sessionExistsOnBackends('deleted')).resolves.toBe('gone')
  })

  // The distinction the whole sweep rests on: a gateway that never answered has
  // not said the session is gone, and a caller acting on it would destroy user
  // state over a dropped packet.
  it('reports unknown when the request fails for any other reason', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('connection refused'))

    await expect(sessionExistsOnBackends('offline')).resolves.toBe('unknown')
  })

  it('treats a 500 as no answer, not as a deletion', async () => {
    vi.mocked(getSession).mockRejectedValue(new ApiError('boom', 500, 'boom'))

    await expect(sessionExistsOnBackends('broken')).resolves.toBe('unknown')
  })

  // A pin is not profile-scoped while the recents list is, so the session may
  // simply live on a profile the current scope never loads.
  it('asks every configured profile before concluding a session is gone', async () => {
    $profiles.set([profile('default'), profile('work')])
    vi.mocked(getSession)
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ id: 'stored-9', profile: 'work' } as SessionInfo)

    await expect(sessionExistsOnBackends('stored-9')).resolves.toBe('present')
    expect(vi.mocked(getSession).mock.calls.map(call => call[1])).toEqual([undefined, 'work'])
  })

  it('is gone only when every profile 404s', async () => {
    $profiles.set([profile('default'), profile('work')])
    vi.mocked(getSession).mockRejectedValue(notFound())

    await expect(sessionExistsOnBackends('stored-9')).resolves.toBe('gone')
    expect(getSession).toHaveBeenCalledTimes(2)
  })
})

// The backend list is a snapshot that can predate an in-flight delete, so a
// refresh landing mid-mutation used to put the row straight back.
describe('delete/archive tombstones', () => {
  const page = (ids: string[]): PaginatedSessions =>
    ({ sessions: ids.map(id => row(id, id)), total: ids.length }) as unknown as PaginatedSessions

  it('keeps a deleted row out of a refresh that still lists it', async () => {
    $sessions.set([row('a', 'A'), row('b', 'B')])
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })
    await deleteSessionLocal('a')

    vi.mocked(listAllProfileSessions).mockResolvedValue(page(['a', 'b']))
    await refreshSessions()

    expect($sessions.get().map(s => s.id)).toEqual(['b'])
    // Still listed by the backend, so the tombstone stays pinned.
    expect($removedSessionIds.get().has('a')).toBe(true)
  })

  it('lifts the tombstone once the backend stops listing the id', async () => {
    $sessions.set([row('a', 'A')])
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })
    await deleteSessionLocal('a')

    pruneSessionTombstones([])

    expect($removedSessionIds.get().size).toBe(0)
  })

  it('undoes the tombstone when the delete fails', async () => {
    $sessions.set([row('a', 'A')])
    vi.mocked(deleteSession).mockRejectedValue(new Error('nope'))
    await deleteSessionLocal('a')

    expect($sessions.get().map(s => s.id)).toEqual(['a'])
    expect($removedSessionIds.get().size).toBe(0)
  })
})

/**
 * MJXHRM-423 — a session verb addressed by an alias.
 *
 * Auto-compression rotates a conversation's stored id and universal deliberately
 * leaves the surfaces holding the old one: a tile tab, a mobile bubble and a
 * restored layout pane all keep the id their chat was OPENED with, which after a
 * compaction is the lineage ROOT. Row lookup has always followed that. The
 * VERBS did not, and the backend does not paper over it uniformly — pin,
 * archive and delete flip the whole compression chain, while `set_session_title`
 * and `update_session_cwd` write a single row that the session list then
 * projects the TIP over.
 *
 * The fixture is the shape every one of these tests needs: the row is loaded
 * under its live tip `tip`, and the caller is holding `root`.
 */
describe('a verb addressed by a pre-rotation id', () => {
  const compacted = (title = 'Compacted chat') =>
    ({ _lineage_root_id: 'root', id: 'tip', title }) as unknown as SessionInfo

  // The one with no other symptom. The rename dialog opens on the correct
  // current title (MJXHRM-386 widened THAT), the user retypes it, the "Renamed"
  // toast fires — and the name goes onto a hidden ancestor row nothing renders.
  it('renames the live tip, not the lineage root the tab is holding', async () => {
    $sessions.set([compacted('Old')])
    vi.mocked(renameSession).mockResolvedValue(undefined as never)

    await renameSessionLocal('root', 'New')

    expect(renameSession).toHaveBeenCalledWith('tip', 'New', undefined)
    expect($sessions.get()[0].title).toBe('New')
  })

  it('still rolls the optimistic rename back when the wire call fails', async () => {
    $sessions.set([compacted('Old')])
    vi.mocked(renameSession).mockRejectedValue(new Error('nope'))

    await renameSessionLocal('root', 'New')

    expect($sessions.get()[0].title).toBe('Old')
  })

  it('removes the row optimistically on delete', async () => {
    $sessions.set([compacted()])
    $sessionsTotal.set(1)
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })

    await deleteSessionLocal('root')

    expect($sessions.get()).toEqual([])
  })

  it('removes the row optimistically on archive', async () => {
    $sessions.set([compacted()])

    await archiveSessionLocal('root')

    expect($sessions.get()).toEqual([])
  })

  // Main is on the live tip; the delete comes from a tile tab on the root. Left
  // comparing identity, the workspace went on rendering a conversation the
  // backend had just dropped, and the next submit into it would 404.
  it('empties main when the session being deleted is the one on screen under another id', async () => {
    $sessions.set([compacted()])
    $activeStoredSessionId.set('tip')
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })

    await deleteSessionLocal('root')

    expect($activeStoredSessionId.get()).toBeNull()
  })

  it('leaves an unrelated session in main alone', async () => {
    $sessions.set([compacted(), row('other', 'Other')])
    $activeStoredSessionId.set('other')
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })

    await deleteSessionLocal('root')

    expect($activeStoredSessionId.get()).toBe('other')
  })
})

/** The question two SURFACES ask of each other — neither holding a row. */
describe('sameStoredSession', () => {
  it('sees one conversation behind a lineage root and its live tip', () => {
    $sessions.set([{ _lineage_root_id: 'root', id: 'tip' } as SessionInfo])

    expect(sameStoredSession('root', 'tip')).toBe(true)
    expect(sameStoredSession('tip', 'root')).toBe(true)
  })

  it('keeps two different conversations apart', () => {
    $sessions.set([{ _lineage_root_id: 'root', id: 'tip' } as SessionInfo, row('other', 'Other')])

    expect(sameStoredSession('root', 'other')).toBe(false)
  })

  it('is identity when no loaded row explains the id, and false for a missing one', () => {
    expect(sameStoredSession('lonely', 'lonely')).toBe(true)
    expect(sameStoredSession('lonely', 'stranger')).toBe(false)
    expect(sameStoredSession(null, 'a')).toBe(false)
    expect(sameStoredSession('a', null)).toBe(false)
  })
})

// The transcript AUTHORITY is the REST endpoint: `session.resume` returns a
// display-reduced history (tool-only assistant rows dropped, tool results
// flattened to {name, context} with no ids), so hydrating from it lost the
// intermediate thinking blocks and collapsed repeated tool calls.
describe('openSession transcript source', () => {
  const resumePayload = (extra: Record<string, unknown> = {}) => ({
    messages: [{ role: 'tool', name: 'terminal', context: 'ls' }],
    session_id: 'runtime-1',
    ...extra
  })

  it('hydrates from the REST transcript, not the resume payload', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: [
        { role: 'user', content: 'do it' },
        {
          role: 'assistant',
          content: '',
          reasoning: 'think 1',
          tool_calls: [{ id: 'a', function: { name: 'terminal', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'a', tool_name: 'terminal', content: 'ok' },
        { role: 'assistant', content: 'Done.' }
      ],
      session_id: 'stored-9'
    } as never)
    vi.mocked(requestGateway).mockResolvedValue(resumePayload())

    await openSession('stored-9')

    // Second arg = the owning profile; undefined on a single-profile install.
    expect(getSessionMessages).toHaveBeenCalledWith('stored-9', undefined)
    const parts = $messages.get().flatMap(m => m.parts)
    // The reasoning survives only in the REST payload.
    expect(parts.filter(p => p.type === 'reasoning')).toHaveLength(1)
    expect(parts.filter(p => p.type === 'tool-call')).toHaveLength(1)
    expect($sessionId.get()).toBe('runtime-1')
  })

  it('falls back to the resume payload when REST is unavailable', async () => {
    vi.mocked(getSessionMessages).mockRejectedValue(new Error('offline'))
    vi.mocked(requestGateway).mockResolvedValue(resumePayload())

    await openSession('stored-9')

    expect(
      $messages
        .get()
        .flatMap(m => m.parts)
        .filter(p => p.type === 'tool-call')
    ).toHaveLength(1)
    expect($sessionId.get()).toBe('runtime-1')
  })

  it('appends the in-flight turn onto the REST transcript', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: [{ role: 'user', content: 'older turn' }],
      session_id: 'stored-9'
    } as never)
    vi.mocked(requestGateway).mockResolvedValue(
      resumePayload({ inflight: { streaming: true, user: 'the running prompt' } })
    )

    await openSession('stored-9')

    const messages = $messages.get()
    expect(messages.map(m => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(messages[2].pending).toBe(true)
    expect($busy.get()).toBe(true)
  })

  it('ignores a stale open that resolves after a newer one', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue({ messages: [], session_id: 'x' } as never)

    let releaseSlow: (value: unknown) => void = () => {}

    const slow = new Promise(resolve => {
      releaseSlow = resolve
    })

    vi.mocked(requestGateway).mockImplementationOnce(() => slow as never)
    vi.mocked(requestGateway).mockResolvedValue({ messages: [], session_id: 'runtime-new' })

    const stale = openSession('stored-old')
    await openSession('stored-new')
    releaseSlow({ messages: [], session_id: 'runtime-old' })
    await stale

    expect($sessionId.get()).toBe('runtime-new')
    expect($activeStoredSessionId.get()).toBe('stored-new')
  })
})

describe('branchCurrentSession', () => {
  const seedThread = () => {
    $activeStoredSessionId.set('stored-1')
    seedActiveSession('runtime-1', {
      storedSessionId: 'stored-1',
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
        { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'second' }] },
        { id: 'm4', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] }
      ]
    })
  }

  // The WHOLE conversation, not just the last turn: a branch shares a past with
  // its parent and diverges from there.
  it('forks the thread up to the last turn into a new session and opens it', async () => {
    seedThread()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await expect(branchCurrentSession()).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({
        messages: [
          { content: 'first', role: 'user' },
          { content: 'answer', role: 'assistant' },
          { content: 'second', role: 'user' },
          { content: 'reply', role: 'assistant' }
        ],
        parent_session_id: 'stored-1'
      })
    )
    expect($sessionId.get()).toBe('runtime-2')
    expect($activeStoredSessionId.get()).toBe('stored-2')
    expect($messages.get().map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect($sessions.get()[0].parent_session_id).toBe('stored-1')
  })

  // MJXHRM-388. Branching AT a message copies everything up TO it — the port
  // sliced `[at, at + 1)`, so the branch was a new chat quoting one reply with
  // the question it answered, and every turn before it, gone. Desktop's own
  // test names this: "only the clicked message survived instead of everything
  // up to it".
  it('forks the thread up to a specific message when given its id', async () => {
    seedThread()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2' } as never)

    await branchCurrentSession('m2')

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({
        messages: [
          { content: 'first', role: 'user' },
          { content: 'answer', role: 'assistant' }
        ]
      })
    )
  })

  it('refuses without a session, while busy, or with nothing to copy', async () => {
    // WITH turns painted, so this leg tests the "no session yet" refusal rather
    // than falling through to the empty-transcript one. Not hypothetical: a
    // slice still hydrating under a placeholder key shows its transcript before
    // it has a wire id, and that is a chat you can try to branch. (Seeded
    // bare, this assertion passed with the guard deleted.)
    seedActiveSession('draft', {
      runtimeSessionId: null,
      storedSessionId: null,
      messages: [{ id: 'd1', role: 'assistant', parts: [{ type: 'text', text: 'painted' }] }]
    })
    await expect(branchCurrentSession()).resolves.toBe(false)

    seedThread()
    updateSession('runtime-1', s => ({ ...s, busy: true }))
    await expect(branchCurrentSession()).resolves.toBe(false)
    updateSession('runtime-1', s => ({ ...s, busy: false }))

    updateSession('runtime-1', s => ({
      ...s,
      messages: [{ id: 's1', role: 'system', parts: [{ type: 'text', text: 'slash:/help' }] }]
    }))
    await expect(branchCurrentSession()).resolves.toBe(false)

    expect(requestGateway).not.toHaveBeenCalled()
  })

  // REGRESSION: assistant-ui addresses "branch in new chat" by message id. When
  // the runtime converter dropped our ids, that id never matched and the branch
  // silently forked the LAST turn instead of the clicked one.
  it('refuses an explicit target that is not in the transcript', async () => {
    seedThread()

    await expect(branchCurrentSession('not-a-real-id')).resolves.toBe(false)
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('reports a failed fork without disturbing the current thread', async () => {
    seedThread()
    vi.mocked(requestGateway).mockRejectedValue(new Error('nope'))

    await expect(branchCurrentSession()).resolves.toBe(false)
    expect($sessionId.get()).toBe('runtime-1')
    expect($messages.get().map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  // MJXHRM-388. Every other mutation path carries the parent's owning profile;
  // this one did not, so `session.create` landed the branch on whichever gateway
  // happened to be live and the conversation jumped databases.
  it('creates the branch on the PARENT session owning profile', async () => {
    seedThread()
    $sessions.set([rowOnProfile('stored-1', 'research')])
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await branchCurrentSession()

    expect(requestGateway).toHaveBeenCalledWith('session.create', expect.objectContaining({ profile: 'research' }))
  })

  // MJXHRM-388. A branch opens BESIDE the chat it came from. Placement lives in
  // the tile/bubble stores, which import this module, so it arrives as a
  // registered opener — and registering one is what stops the branch claiming
  // the main pane and pushing the parent off screen.
  it('hands the branch to the registered opener instead of claiming main', async () => {
    seedThread()
    const opened: [string, null | string][] = []
    setBranchedSessionOpener((id, parent) => opened.push([id, parent]))
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await expect(branchCurrentSession()).resolves.toBe(true)

    // The PARENT rides along, so the opener can put the branch in its strip
    // rather than in the workspace's.
    expect(opened).toEqual([['stored-2', 'stored-1']])
    // The parent is still the loaded chat: nothing was displaced.
    expect($activeStoredSessionId.get()).toBe('stored-1')
    // ...and the branch is listed, so the tab the opener creates has a row.
    expect($sessions.get().some(s => s.id === 'stored-2')).toBe(true)
  })

  // MJXHRM-388. Universal renders N chats at once, and hydrated message ids are
  // POSITIONAL (`h3-assistant`) — so "branch in new chat" on a tile's message
  // resolved a same-numbered message in the FOREGROUND chat and forked that
  // conversation instead, with no error to notice. Every other per-surface
  // action already routes by the surface's own view.
  it('branches the SURFACE it was invoked from, not the foreground chat', async () => {
    seedThread()
    seedSession('runtime-tile', {
      storedSessionId: 'stored-tile',
      runtimeSessionId: 'runtime-tile',
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'tile question' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'tile answer' }] }
      ]
    })
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)
    // As the app always is (app/contrib/controller); without one the branch
    // falls back to claiming main, which is the documented last resort.
    setBranchedSessionOpener(() => undefined)

    await expect(
      branchCurrentSession('m2', {
        busy: false,
        cwd: '/tile/repo',
        messages: $sessionStates.get()['runtime-tile'].messages,
        runtimeId: 'runtime-tile',
        storedId: 'stored-tile'
      })
    ).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({
        cwd: '/tile/repo',
        messages: [
          { content: 'tile question', role: 'user' },
          { content: 'tile answer', role: 'assistant' }
        ],
        parent_session_id: 'stored-tile'
      })
    )
    // The chat in main was never touched.
    expect($activeStoredSessionId.get()).toBe('stored-1')
    expect($messages.get().map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  // MJXHRM-386/388. A tile holds the stored id it was opened with forever, so a
  // parent that has since rotated through a compression must be re-resolved to
  // its live tip — otherwise the branch nests under a dead id.
  it('nests under the parent row LIVE tip, not the id the surface holds', async () => {
    seedThread()
    $projectTree.set([treeWith([{ id: 'tip-1', _lineage_root_id: 'root-1' } as unknown as SessionInfo])])
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await branchCurrentSession(undefined, {
      busy: false,
      cwd: '',
      messages: $messages.get(),
      runtimeId: 'runtime-1',
      storedId: 'root-1'
    })

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({ parent_session_id: 'tip-1' })
    )
  })

  // MJXHRM-388. The optimistic row must be OWNED before its id is published:
  // `$activeStoredSessionId`'s subscriber reads the owner right then to remember
  // this profile's place, and an unowned row is remembered against whichever
  // gateway is live — the cross-profile bleed `profile` exists to close.
  it('stamps the branch row with its profile before the id goes active', async () => {
    seedThread()
    $sessions.set([rowOnProfile('stored-1', 'research')])
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    let ownerWhenPublished: string | undefined

    const stop = $activeStoredSessionId.listen(id => {
      if (id === 'stored-2') {
        ownerWhenPublished = knownSessionProfile('stored-2')
      }
    })

    await branchCurrentSession()
    stop()

    expect(ownerWhenPublished).toBe('research')
  })
})

/**
 * MJXHRM-386 — a branch's DIRECTORY, which is where its colour comes from.
 *
 * `branchStoredSession` branches a session the user is not looking at, so its
 * parent is exactly the sort that has aged out of the recents page. It resolved
 * that parent with a `$sessions.find(...)`, and a miss meant an empty `cwd`:
 * the branch was created in the gateway's default directory, belonged to no
 * project, and so inherited no lane and no colour.
 */
describe('branchStoredSession — the branch inherits its parent directory', () => {
  const transcript = () =>
    vi.mocked(getSessionMessages).mockResolvedValue({
      messages: [{ role: 'user', content: 'first' }],
      session_id: 'x'
    } as never)

  it('takes the cwd from a parent that is only in the project tree', async () => {
    transcript()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)
    $sessions.set([])
    $projectTree.set([treeWith([{ cwd: '/www/app', id: 'old-1' } as unknown as SessionInfo])])

    await branchStoredSession('old-1')

    expect(requestGateway).toHaveBeenCalledWith('session.create', expect.objectContaining({ cwd: '/www/app' }))
  })

  it('records the parent as the row live tip, not the pre-rotation id it was given', async () => {
    transcript()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)
    $sessions.set([])
    $projectTree.set([
      treeWith([{ _lineage_root_id: 'root-1', cwd: '/www/app', id: 'tip-1' } as unknown as SessionInfo])
    ])

    await branchStoredSession('root-1')

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({ parent_session_id: 'tip-1' })
    )
  })

  // The optimistic row the sidebar shows before the next refresh: its `cwd`
  // decides the lane and the inherited colour, and it used to be seeded from
  // whatever chat was on SCREEN — which for a background branch is a different
  // session in, quite possibly, a different project.
  it('seeds the optimistic row with the branch directory, not the open chat one', async () => {
    transcript()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)
    // The chat on SCREEN, in a different project entirely.
    seedActiveSession('runtime-0', { cwd: '/somewhere/else' })
    expect($currentCwd.get()).toBe('/somewhere/else')
    $sessions.set([])
    $projectTree.set([treeWith([{ cwd: '/www/app', id: 'old-1' } as unknown as SessionInfo])])

    await branchStoredSession('old-1')

    expect($sessions.get().find(s => s.id === 'stored-2')?.cwd).toBe('/www/app')
  })
})

describe('refreshSessions — profile scope', () => {
  const page = (over: Partial<PaginatedSessions> = {}): PaginatedSessions =>
    ({ limit: 30, offset: 0, sessions: [row('a', 'A')], total: 7, ...over }) as PaginatedSessions

  it('asks the aggregator for the active profile in concrete scope', async () => {
    $activeProfile.set('research')
    vi.mocked(listAllProfileSessions).mockResolvedValue(page({ profile_totals: { research: 3, default: 40 } }))

    await refreshSessions()

    expect(listAllProfileSessions).toHaveBeenCalledWith($sessionsLimit.get(), 1, 'exclude', 'recent', 'research')
    // The scoped total wins over the aggregate one.
    expect($sessionsTotal.get()).toBe(3)
  })

  it("asks for 'all' in the browse scope and keeps the aggregate total", async () => {
    $showAllProfiles.set(true)
    vi.mocked(listAllProfileSessions).mockResolvedValue(page({ profile_totals: { default: 4 } }))

    await refreshSessions()

    expect(listAllProfileSessions).toHaveBeenCalledWith($sessionsLimit.get(), 1, 'exclude', 'recent', 'all')
    expect($sessionsTotal.get()).toBe(7)
  })

  it('falls back to the aggregate total when the scope has no per-profile entry', async () => {
    vi.mocked(listAllProfileSessions).mockResolvedValue(page())

    await refreshSessions()

    expect(listAllProfileSessions).toHaveBeenCalledWith($sessionsLimit.get(), 1, 'exclude', 'recent', 'default')
    expect($sessionsTotal.get()).toBe(7)
  })
})

/**
 * MJXHRM-383. `SidebarSessionRow` is `memo(…, rowPropsEqual)` and that
 * comparator deliberately ignores the handler props, so the ONLY thing that can
 * make a row bail out is `Object.is(prev.session, next.session)`. Every refresh
 * below is a JSON-parsed page, so without identity sharing every row in every
 * lane re-renders on a poll that changed nothing — which is what made the
 * handler stabilization above it unobservable.
 */
describe('refreshSessions — row identity', () => {
  const page = (sessions: SessionInfo[]): PaginatedSessions =>
    ({ limit: 30, offset: 0, sessions, total: sessions.length }) as PaginatedSessions

  /** A fresh page object graph each call — what the transport really hands back. */
  const serverPage = (rows: { id: string; last_active: number; title: string }[]): PaginatedSessions =>
    page(rows.map(r => ({ ...r })) as unknown as SessionInfo[])

  const ROWS = [
    { id: 'a', last_active: 10, title: 'A' },
    { id: 'b', last_active: 20, title: 'B' },
    { id: 'c', last_active: 30, title: 'C' }
  ]

  it('publishes nothing when the refreshed page is content-identical', async () => {
    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage(ROWS))
    await refreshSessions()

    const first = $sessions.get()
    const published: unknown[] = []
    const stop = $sessions.listen(value => published.push(value))

    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage(ROWS))
    await refreshSessions()
    stop()

    // Same array — so nanostores never notifies and the sidebar never renders.
    expect($sessions.get()).toBe(first)
    expect(published).toEqual([])
  })

  it('leaves the untouched rows on their old objects when one row changes', async () => {
    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage(ROWS))
    await refreshSessions()

    const before = $sessions.get()

    vi.mocked(listAllProfileSessions).mockResolvedValue(
      serverPage([ROWS[0], { ...ROWS[1], last_active: 999 }, ROWS[2]])
    )
    await refreshSessions()

    const after = $sessions.get()

    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].last_active).toBe(999)
  })

  it('keeps row identity across the recency reorder a new message causes', async () => {
    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage(ROWS))
    await refreshSessions()

    const before = $sessions.get()

    // 'c' got a message: it jumps to the head and shifts the rest down. Nothing
    // about a/b changed, so their rows must not repaint.
    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage([ROWS[2], ROWS[0], ROWS[1]]))
    await refreshSessions()

    const after = $sessions.get()

    expect(after.map(s => s.id)).toEqual(['c', 'a', 'b'])
    expect(after[0]).toBe(before[2])
    expect(after[1]).toBe(before[0])
    expect(after[2]).toBe(before[1])
  })

  it('still evicts a tombstoned row rather than reviving it from the previous page', async () => {
    // The identity gate must not become a way for a deleted row to survive.
    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage(ROWS))
    await refreshSessions()

    $removedSessionIds.set(new Set(['b']))
    vi.mocked(listAllProfileSessions).mockResolvedValue(serverPage(ROWS))
    await refreshSessions()

    expect($sessions.get().map(s => s.id)).toEqual(['a', 'c'])
  })
})

describe('loadMoreSessions', () => {
  const page = (sessions: SessionInfo[], over: Partial<PaginatedSessions> = {}): PaginatedSessions =>
    ({ limit: 30, offset: 0, sessions, total: 7, ...over }) as PaginatedSessions

  it('asks for the NEXT page by recency depth and appends it', async () => {
    $sessions.set([row('a', 'A'), row('b', 'B')])
    $sessionsLimit.set(2)
    vi.mocked(listAllProfileSessions).mockResolvedValue(page([row('c', 'C')]))

    await loadMoreSessions()

    // offset = how deep into the recency window we have read; the window is not
    // re-fetched.
    expect(listAllProfileSessions).toHaveBeenCalledWith(30, 1, 'exclude', 'recent', 'default', {}, 2)
    expect($sessions.get().map(s => s.id)).toEqual(['a', 'b', 'c'])
    expect($sessionsLimit.get()).toBe(3)
  })

  // The endpoints pass `include_pinned=True` and APPEND back-filled pins after
  // the recency window, so a page can carry more rows than its limit — and the
  // extras hold no window position. Counting them into the cursor skipped one
  // real conversation per pin, permanently: never fetched, never rendered, and
  // no visible gap to notice. (Reported by SE-H alongside `pageWindow`.)
  it('does not let back-filled pins advance the cursor past what it read', async () => {
    $sessions.set([row('a', 'A')])
    $sessionsLimit.set(1)

    // A full page of 30, plus two pins the server appended past the window.
    const window30 = Array.from({ length: 30 }, (_, i) => row(`w${i}`, `W${i}`))
    vi.mocked(listAllProfileSessions).mockResolvedValue(page([...window30, row('pin1', 'P1'), row('pin2', 'P2')]))

    await loadMoreSessions()

    // 1 + 30, NOT 1 + 32 — the two pins were not window positions.
    expect($sessionsLimit.get()).toBe(31)

    vi.mocked(listAllProfileSessions).mockResolvedValue(page([]))
    await loadMoreSessions()

    expect(listAllProfileSessions).toHaveBeenLastCalledWith(30, 1, 'exclude', 'recent', 'default', {}, 31)
  })

  // Ordering is by recency, so a session that gets a message between the two
  // fetches slides into the earlier page and would otherwise render twice.
  it('drops a row that shifted into the previous page', async () => {
    $sessions.set([row('a', 'A'), row('b', 'B')])
    $sessionsLimit.set(2)
    vi.mocked(listAllProfileSessions).mockResolvedValue(page([row('b', 'B'), row('c', 'C')]))

    await loadMoreSessions()

    expect($sessions.get().map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the loaded rows when the next page comes back empty', async () => {
    $sessions.set([row('a', 'A')])
    $sessionsLimit.set(1)
    vi.mocked(listAllProfileSessions).mockResolvedValue(page([]))

    await loadMoreSessions()

    expect($sessions.get().map(s => s.id)).toEqual(['a'])
    expect($sessionsLimit.get()).toBe(1)
  })

  it('keeps the loaded rows when the fetch fails', async () => {
    $sessions.set([row('a', 'A')])
    vi.mocked(listAllProfileSessions).mockRejectedValue(new Error('offline'))

    await loadMoreSessions()

    expect($sessions.get().map(s => s.id)).toEqual(['a'])
  })
})

describe('unread-finished tracking', () => {
  it('clears a session id the moment it becomes the active session', () => {
    $unreadFinishedSessionIds.set(['stored-a', 'stored-b'])

    $activeStoredSessionId.set('stored-a')

    expect($unreadFinishedSessionIds.get()).toEqual(['stored-b'])
  })

  it('leaves the set alone when the chat goes back to a fresh draft', () => {
    $unreadFinishedSessionIds.set(['stored-a'])

    $activeStoredSessionId.set(null)

    expect($unreadFinishedSessionIds.get()).toEqual(['stored-a'])
  })

  it('keeps the same array reference when the id was never unread', () => {
    const before = ['stored-a']
    $unreadFinishedSessionIds.set(before)

    clearUnreadFinishedSession('stored-z')

    expect($unreadFinishedSessionIds.get()).toBe(before)
  })
})

describe('pinned rows survive the loaded window', () => {
  it('falls back to the last-known row for a pin that scrolled out of the page', () => {
    const pinned = row('stored-pin', 'Pinned chat')

    // Seen on a page: cached.
    $pinnedSessionIds.set(['stored-pin'])
    $sessions.set([pinned, row('stored-other', 'Other')])

    expect(pinnedSessionRows($sessions.get(), ['stored-pin'])).toEqual([pinned])

    // A later page no longer reaches it — the pin is still stored, so the
    // section must still show it rather than silently dropping the row.
    $sessions.set([row('stored-other', 'Other')])

    expect(pinnedSessionRows($sessions.get(), ['stored-pin'])).toEqual([pinned])
  })

  it('forgets a row once its pin is gone', () => {
    $pinnedSessionIds.set(['stored-pin'])
    $sessions.set([row('stored-pin', 'Pinned chat')])
    expect($pinnedSessionCache.get()['stored-pin']).toBeDefined()

    $pinnedSessionIds.set([])
    $sessions.set([])

    expect($pinnedSessionCache.get()['stored-pin']).toBeUndefined()
  })

  // MJXHRM-414. The cache fallback above is what makes the Pinned list survive
  // pagination — and it is exactly what let a DELETED session go on rendering
  // there: the row leaves `$sessions`, the cache still has it, and nothing ever
  // released the pin. The two halves of the fix are pinned separately, because
  // either alone leaves a window where the tombstone is visible.
  it('deleting a pinned session releases its pin', async () => {
    $pinnedSessionIds.set(['stored-pin'])
    $sessions.set([row('stored-pin', 'Pinned chat')])
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })

    await deleteSessionLocal('stored-pin')

    expect($pinnedSessionIds.get()).toEqual([])
    expect(pinnedSessionRows($sessions.get(), $pinnedSessionIds.get())).toEqual([])
  })

  // The half of that fix nothing could see: a compaction rotates the live id,
  // and the pin stays on the durable lineage root. The delete arrives with the
  // TIP id, so releasing only the id it was handed leaves the pin standing —
  // and the Pinned section resolves the deleted chat right back out of the
  // cache under the root key.
  it('releases the pin of a compacted session, whose pin id is not the id being deleted', async () => {
    $pinnedSessionIds.set(['root'])
    $sessions.set([{ _lineage_root_id: 'root', id: 'tip' } as SessionInfo])
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })

    await deleteSessionLocal('tip')

    expect($pinnedSessionIds.get()).toEqual([])
  })

  // And the mirror image, which is why BOTH ids are released rather than just
  // the durable one: a row can reach a pin control without its lineage stamp —
  // a server search result carries `session_id` and nothing else — so a pin can
  // legitimately be stored under the live tip id.
  it('releases a pin stored under the live tip id, not just the lineage root', async () => {
    $pinnedSessionIds.set(['tip'])
    $sessions.set([{ _lineage_root_id: 'root', id: 'tip' } as SessionInfo])
    vi.mocked(deleteSession).mockResolvedValue({ ok: true })

    await deleteSessionLocal('tip')

    expect($pinnedSessionIds.get()).toEqual([])
  })

  it('restores the pin when the delete RPC fails', async () => {
    $pinnedSessionIds.set(['stored-pin'])
    $sessions.set([row('stored-pin', 'Pinned chat')])
    vi.mocked(deleteSession).mockRejectedValue(new Error('nope'))

    await deleteSessionLocal('stored-pin')

    expect($pinnedSessionIds.get()).toEqual(['stored-pin'])
  })

  it('never renders a tombstoned row, even while the delete is in flight', () => {
    $pinnedSessionIds.set(['stored-pin'])
    $sessions.set([row('stored-pin', 'Pinned chat')])
    expect(pinnedSessionRows($sessions.get(), ['stored-pin'])).toHaveLength(1)

    $removedSessionIds.set(new Set(['stored-pin']))

    expect(pinnedSessionRows($sessions.get(), ['stored-pin'])).toEqual([])
  })

  // The two tombstone checks in `pinnedSessionRows` are NOT redundant, and the
  // test above cannot tell them apart: with a pin id equal to the row id, either
  // one alone passes it. A compacted chat separates them, and each check is the
  // only thing covering its own case.
  it('drops a pin whose stored id was tombstoned, even when its row surfaces under another id', () => {
    // Deleted from a surface holding the row: `removalIds` tombstoned the
    // lineage root, and the cached row still answers under its live tip id.
    const tip = { _lineage_root_id: 'root', id: 'tip' } as SessionInfo
    $pinnedSessionIds.set(['root'])
    $sessions.set([tip])
    expect(pinnedSessionRows($sessions.get(), ['root'])).toEqual([tip])

    $removedSessionIds.set(new Set(['root']))

    expect(pinnedSessionRows($sessions.get(), ['root'])).toEqual([])
  })

  it('drops a resolved row that was tombstoned under its live id, though the pin id was not', () => {
    // The mirror image: deleted by an id the loaded rows could not resolve, so
    // only the live tip got a tombstone while the pin is stored on the root.
    const tip = { _lineage_root_id: 'root', id: 'tip' } as SessionInfo
    $pinnedSessionIds.set(['root'])
    $sessions.set([tip])

    $removedSessionIds.set(new Set(['tip']))

    expect(pinnedSessionRows($sessions.get(), ['root'])).toEqual([])
  })

  // A session id means nothing on another backend, so the cached ROWS are
  // gateway-bound even though the pin ids are not. Left standing across a soft
  // switch they kept rendering the previous gateway's conversations in the new
  // one's Pinned section — resolvable by nothing, openable to nothing.
  it('forgets every cached row, and the persisted copy, when the backend changes', () => {
    $pinnedSessionIds.set(['stored-pin'])
    $sessions.set([row('stored-pin', 'Pinned chat')])
    expect(localStorage.getItem('hermes.pinnedSessionRows')).toContain('stored-pin')

    clearPinnedSessionCache()

    expect($pinnedSessionCache.get()).toEqual({})
    // Persisted too, or the next launch reads the old gateway's rows back in.
    expect(localStorage.getItem('hermes.pinnedSessionRows')).not.toContain('stored-pin')
    // The pin itself stays: it mirrors each gateway's own durable flag, and the
    // one we are leaving must still have its pins when we come back.
    expect($pinnedSessionIds.get()).toEqual(['stored-pin'])
  })
})

// The sweep that releases a pin whose session another client deleted only runs
// when a WHOLE window has landed — the one moment a pin's absence from
// `$sessions` carries information, because the backend back-fills pinned rows
// past the limit. An epoch bumped on a failed fetch would have it acting on a
// list that says nothing at all.
describe('$sessionsListEpoch', () => {
  it('counts a refresh that landed', async () => {
    const before = $sessionsListEpoch.get()
    vi.mocked(listAllProfileSessions).mockResolvedValue({
      sessions: [row('a', 'A')],
      total: 1
    } as unknown as PaginatedSessions)

    await refreshSessions()

    expect($sessionsListEpoch.get()).toBe(before + 1)
  })

  it('does not count a refresh that failed', async () => {
    const before = $sessionsListEpoch.get()
    vi.mocked(listAllProfileSessions).mockRejectedValue(new Error('offline'))

    await refreshSessions()

    expect($sessionsListEpoch.get()).toBe(before)
  })
})

// The icon table (app/messaging/platform-icon.tsx) and this source list answer
// two halves of one question, and a platform in only one of them is invisible in
// the other: photon and buzz shipped with icons and setup copy but no entry
// here, so their sessions were never grouped out of recents.
describe('messaging sources stay in sync with the icon table', () => {
  it('recognises every platform that has an icon, case-insensitively', () => {
    for (const source of ['photon', 'buzz', 'telegram', 'discord', 'bluebubbles']) {
      expect(isMessagingSource(source)).toBe(true)
      expect(isMessagingSource(source.toUpperCase())).toBe(true)
    }
  })

  it('still excludes local sources', () => {
    expect(isMessagingSource('cli')).toBe(false)
    expect(isMessagingSource('cron')).toBe(false)
    expect(isMessagingSource(null)).toBe(false)
  })

  it('labels the new platforms rather than falling back to a capitalised id', () => {
    expect(messagingSourceLabel('photon')).toBe('Photon')
    expect(messagingSourceLabel('buzz')).toBe('Buzz')
  })
})
