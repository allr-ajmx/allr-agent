import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  listAllProfileSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  setSessionArchived: vi.fn(),
  searchSessions: vi.fn(),
  setApiRequestProfile: vi.fn()
}))
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))

import { deleteSession, getSessionMessages, listAllProfileSessions, renameSession } from '@/hermes'
import { $busy, $currentCwd, $messages, $sessionId } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { $showAllProfiles } from '@/store/profile'
import { $activeProfile } from '@/store/profiles'
import type { PaginatedSessions, SessionInfo } from '@/types/hermes'

import {
  $activeStoredSessionId,
  $sessions,
  $sessionsLimit,
  $sessionsTotal,
  branchCurrentSession,
  deleteSessionLocal,
  openSession,
  refreshSessions,
  renameSessionLocal,
  resetSessionsPaging
} from './session'

const row = (id: string, title: string): SessionInfo => ({ id, title }) as unknown as SessionInfo
const rowWithCwd = (id: string, cwd: null | string): SessionInfo => ({ id, cwd }) as unknown as SessionInfo

afterEach(() => {
  vi.clearAllMocks()
  $sessions.set([])
  $sessionsTotal.set(0)
  $activeStoredSessionId.set(null)
  $messages.set([])
  $currentCwd.set('')
  $showAllProfiles.set(false)
  $activeProfile.set(null)
  resetSessionsPaging()
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
    $currentCwd.set('/home/me/previous-chat')
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

    expect(getSessionMessages).toHaveBeenCalledWith('stored-9')
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
    $sessionId.set('runtime-1')
    $activeStoredSessionId.set('stored-1')
    $messages.set([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }
    ])
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
    $sessionId.set(null)
    await expect(branchCurrentSession()).resolves.toBe(false)

    seedThread()
    $busy.set(true)
    await expect(branchCurrentSession()).resolves.toBe(false)
    $busy.set(false)

    $messages.set([{ id: 's1', role: 'system', parts: [{ type: 'text', text: 'slash:/help' }] }])
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
