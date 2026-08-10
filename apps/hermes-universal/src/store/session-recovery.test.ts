import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestGateway = vi.fn()
const knownSessionProfile = vi.fn<(id: string) => string | undefined>()
const sessionProfileIsAmbiguous = vi.fn(() => false)
const resolveSessionProfile = vi.fn(async () => undefined)
const aliasStoredSessionId = vi.fn()
const rekeySession = vi.fn()
const runtimeKeyForStoredSession = vi.fn<(id: null | string) => null | string>(() => null)

vi.mock('@/store/gateway', () => ({
  requestGateway: (...args: unknown[]) => requestGateway(...args)
}))

vi.mock('@/store/session', () => ({
  knownSessionProfile: (id: string) => knownSessionProfile(id),
  resolveSessionProfile: () => resolveSessionProfile(),
  sessionProfileIsAmbiguous: () => sessionProfileIsAmbiguous()
}))

vi.mock('@/store/session-state-types', () => ({
  aliasStoredSessionId: (...args: unknown[]) => aliasStoredSessionId(...args),
  rekeySession: (...args: unknown[]) => rekeySession(...args),
  runtimeKeyForStoredSession: (id: null | string) => runtimeKeyForStoredSession(id)
}))

const { isSessionNotFoundError, SessionRecoveryAborted, withSessionNotFoundResume } = await import('./session-recovery')

const notFound = () => new Error('session not found: dead-runtime')

beforeEach(() => {
  requestGateway.mockReset()
  knownSessionProfile.mockReset()
  sessionProfileIsAmbiguous.mockReset().mockReturnValue(false)
  resolveSessionProfile.mockReset().mockResolvedValue(undefined)
  aliasStoredSessionId.mockReset()
  rekeySession.mockReset()
  runtimeKeyForStoredSession.mockReset().mockReturnValue(null)
})

describe('isSessionNotFoundError', () => {
  it('matches the gateway wording and nothing else', () => {
    expect(isSessionNotFoundError(notFound())).toBe(true)
    expect(isSessionNotFoundError(new Error('Session Not Found'))).toBe(true)
    expect(isSessionNotFoundError(new Error('request timed out: prompt.submit'))).toBe(false)
  })
})

describe('withSessionNotFoundResume', () => {
  it('passes a healthy call straight through, with no resume', async () => {
    const call = vi.fn(async () => 'ok')

    await expect(withSessionNotFoundResume('live-1', 'stored-1', call)).resolves.toEqual({
      recovered: false,
      result: 'ok',
      sessionId: 'live-1'
    })
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('resumes once on a stale runtime and retries with the fresh id', async () => {
    requestGateway.mockResolvedValue({ session_id: 'live-2' })

    const call = vi.fn(async (id: string) => {
      if (id === 'live-1') {
        throw notFound()
      }

      return id
    })

    await expect(withSessionNotFoundResume('live-1', 'stored-1', call)).resolves.toEqual({
      recovered: true,
      result: 'live-2',
      sessionId: 'live-2'
    })

    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-1',
      omit_messages: true
    })
    // The recovered binding is published, or every later call still holds the
    // dead id and recovers again on each one. With no open slice there is
    // nothing to move, so the index alias is the whole publish.
    expect(aliasStoredSessionId).toHaveBeenCalledWith('stored-1', 'live-2')
    expect(rekeySession).not.toHaveBeenCalled()
  })

  // MJXHRM-308: the default used to be `aliasStoredSessionId(stored, live)`,
  // which resolves the LIVE id through the stored-id index — a silent no-op for
  // any resumed session. The slice stayed under its dead key, the router
  // addressed frames by the new one, and the session hung busy forever.
  it('MOVES an open slice onto the recovered runtime id', async () => {
    requestGateway.mockResolvedValue({ session_id: 'live-2' })
    runtimeKeyForStoredSession.mockReturnValue('live-1')

    await withSessionNotFoundResume('live-1', 'stored-1', async id => {
      if (id === 'live-1') {
        throw notFound()
      }
    })

    expect(rekeySession).toHaveBeenCalledWith('live-1', 'live-2', {
      runtimeSessionId: 'live-2',
      storedSessionId: 'stored-1'
    })
    expect(aliasStoredSessionId).not.toHaveBeenCalled()
  })

  it('does not rekey a slice that is already under the recovered id', async () => {
    requestGateway.mockResolvedValue({ session_id: 'live-2' })
    runtimeKeyForStoredSession.mockReturnValue('live-2')

    await withSessionNotFoundResume('live-1', 'stored-1', async id => {
      if (id === 'live-1') {
        throw notFound()
      }
    })

    expect(rekeySession).not.toHaveBeenCalled()
  })

  it('resumes on the owning profile without probing a single-profile install', async () => {
    knownSessionProfile.mockReturnValue('work')
    requestGateway.mockResolvedValue({ session_id: 'live-2' })

    await withSessionNotFoundResume('live-1', 'stored-1', async id => {
      if (id === 'live-1') {
        throw notFound()
      }
    })

    expect(requestGateway).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-1',
      omit_messages: true,
      profile: 'work'
    })
    expect(resolveSessionProfile).not.toHaveBeenCalled()
  })

  it('retries exactly once — a second failure is a real error', async () => {
    requestGateway.mockResolvedValue({ session_id: 'live-2' })

    const call = vi.fn(async () => {
      throw notFound()
    })

    await expect(withSessionNotFoundResume('live-1', 'stored-1', call)).rejects.toThrow(/session not found/)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('rethrows the ORIGINAL error when the resume itself fails', async () => {
    requestGateway.mockRejectedValue(new Error('no such stored session'))

    await expect(
      withSessionNotFoundResume('live-1', 'stored-1', async () => {
        throw notFound()
      })
    ).rejects.toThrow(/session not found/)
  })

  it('does not recover without a stored id (a never-persisted draft)', async () => {
    await expect(
      withSessionNotFoundResume('live-1', null, async () => {
        throw notFound()
      })
    ).rejects.toThrow(/session not found/)
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('aborts instead of retrying when the caller says the user moved on', async () => {
    requestGateway.mockResolvedValue({ session_id: 'live-2' })

    const call = vi.fn(async (id: string) => {
      if (id === 'live-1') {
        throw notFound()
      }
    })

    await expect(
      withSessionNotFoundResume('live-1', 'stored-1', call, { driftReason: () => 'profile switched' })
    ).rejects.toBeInstanceOf(SessionRecoveryAborted)

    // The retry must NOT land — that is the whole point of the veto.
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('recovers from a gateway timeout only when the caller opts in', async () => {
    requestGateway.mockResolvedValue({ session_id: 'live-2' })

    const timeout = () => new Error('request timed out: prompt.submit')

    await expect(
      withSessionNotFoundResume('live-1', 'stored-1', async () => {
        throw timeout()
      })
    ).rejects.toThrow(/timed out/)

    const call = vi.fn(async (id: string) => {
      if (id === 'live-1') {
        throw timeout()
      }

      return id
    })

    await expect(
      withSessionNotFoundResume('live-1', 'stored-1', call, {}, { alsoTimeout: true })
    ).resolves.toMatchObject({ recovered: true, sessionId: 'live-2' })
  })
})
