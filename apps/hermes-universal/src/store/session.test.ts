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
vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: () => () => {},
  requestGateway: vi.fn()
}))

import { deleteSession, getSession, getSessionMessages, listAllProfileSessions, renameSession } from '@/hermes'
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
import {
  $activeStoredSessionId,
  $pinnedSessionCache,
  $removedSessionIds,
  $sessions,
  $sessionsLimit,
  $sessionsTotal,
  $unreadFinishedSessionIds,
  archiveSessionLocal,
  branchCurrentSession,
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
  setBranchedSessionOpener
} from './session'

const row = (id: string, title: string): SessionInfo => ({ id, title }) as unknown as SessionInfo
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

    let release = () => {}
    vi.mocked(requestGateway).mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ messages: [], session_id: 'runtime-popped' })
        }) as never
    )

    const reclaiming = reclaimSessionTransport('stored-popped')

    // The user switches chats mid-reclaim. The generation counter answers "is
    // this still the chat being switched to", which a background rebind is not
    // asking — bumping it must not silently skip the resume.
    seedSession('runtime-other', { storedSessionId: 'stored-other' })
    openSession('stored-other')
    release()
    await reclaiming

    expect(requestGateway).toHaveBeenCalledWith('session.resume', { session_id: 'stored-popped', cols: 96 })
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
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }
      ]
    })
  }

  it('forks the last turn into a new session and opens it', async () => {
    seedThread()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await expect(branchCurrentSession()).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({
        messages: [{ content: 'answer', role: 'assistant' }],
        parent_session_id: 'stored-1'
      })
    )
    expect($sessionId.get()).toBe('runtime-2')
    expect($activeStoredSessionId.get()).toBe('stored-2')
    expect($messages.get().map(m => m.id)).toEqual(['m2'])
    expect($sessions.get()[0].parent_session_id).toBe('stored-1')
  })

  it('forks from a specific message when given its id', async () => {
    seedThread()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2' } as never)

    await branchCurrentSession('m1')

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({ messages: [{ content: 'first', role: 'user' }] })
    )
  })

  it('refuses without a session, while busy, or with nothing to copy', async () => {
    seedActiveSession('draft', { runtimeSessionId: null, storedSessionId: null })
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
    expect($messages.get().map(m => m.id)).toEqual(['m1', 'm2'])
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
    const opened: string[] = []
    setBranchedSessionOpener(id => opened.push(id))
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await expect(branchCurrentSession()).resolves.toBe(true)

    expect(opened).toEqual(['stored-2'])
    // The parent is still the loaded chat: nothing was displaced.
    expect($activeStoredSessionId.get()).toBe('stored-1')
    // ...and the branch is listed, so the tab the opener creates has a row.
    expect($sessions.get().some(s => s.id === 'stored-2')).toBe(true)
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
