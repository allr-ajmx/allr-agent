import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Hermes from '@/hermes'

// Partial: `@/hermes` is imported at module scope by the profile store, which
// this file pulls in transitively through `@/store/session`.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof Hermes>()),
  getSession: vi.fn()
}))

import { getSession } from '@/hermes'
import {
  __resetSessionLinkTitleCache,
  fetchSessionLinkTitle,
  lookupLocalSessionTitle,
  parseSessionRefValue,
  sessionRefFallbackLabel
} from '@/lib/session-link-title'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

const row = (patch: Partial<SessionInfo>): SessionInfo => ({ id: 'x', ...patch }) as SessionInfo

beforeEach(() => {
  __resetSessionLinkTitleCache()
  $sessions.set([])
  vi.mocked(getSession).mockReset()
})

describe('parseSessionRefValue', () => {
  it('splits a profiled ref', () => {
    expect(parseSessionRefValue('work/20260809_143312_a1b2')).toEqual({
      profile: 'work',
      sessionId: '20260809_143312_a1b2'
    })
  })

  it('treats a bare id as "this profile"', () => {
    expect(parseSessionRefValue('20260809_143312_a1b2')).toEqual({ profile: null, sessionId: '20260809_143312_a1b2' })
    expect(parseSessionRefValue('  ')).toEqual({ profile: null, sessionId: '' })
  })
})

describe('sessionRefFallbackLabel', () => {
  it('truncates a long id and leaves a short one alone', () => {
    expect(sessionRefFallbackLabel('20260809_143312_a1b2')).toBe('20260809…')
    expect(sessionRefFallbackLabel('short')).toBe('short')
  })
})

describe('lookupLocalSessionTitle', () => {
  it('reads the sidebar list, preferring the title over the preview', () => {
    $sessions.set([row({ id: 's1', title: 'Ship the thing', preview: 'hello' })])

    expect(lookupLocalSessionTitle('s1')).toBe('Ship the thing')
  })

  it('falls back to the preview, then to nothing', () => {
    $sessions.set([row({ id: 's1', preview: 'hello there' })])

    expect(lookupLocalSessionTitle('s1')).toBe('hello there')
    expect(lookupLocalSessionTitle('s2')).toBe('')
  })

  // The same id can exist in two profiles and mean two conversations.
  it('will not match a row from another profile', () => {
    $sessions.set([row({ id: 's1', profile: 'work', title: 'Work thing' })])

    expect(lookupLocalSessionTitle('home/s1')).toBe('')
    expect(lookupLocalSessionTitle('work/s1')).toBe('Work thing')
  })
})

describe('fetchSessionLinkTitle', () => {
  it('answers from the sidebar list without a round-trip', async () => {
    $sessions.set([row({ id: 's1', title: 'Ship the thing' })])

    expect(await fetchSessionLinkTitle('s1')).toBe('Ship the thing')
    expect(getSession).not.toHaveBeenCalled()
  })

  // A transcript can carry the same link a dozen times; each chip asking for
  // itself would be a dozen requests for one answer.
  it('dedupes concurrent lookups down to one request', async () => {
    vi.mocked(getSession).mockResolvedValue(row({ id: 's9', title: 'Resolved' }))

    const [a, b] = await Promise.all([fetchSessionLinkTitle('s9'), fetchSessionLinkTitle('s9')])

    expect([a, b]).toEqual(['Resolved', 'Resolved'])
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('caches across calls, including a resolved-to-nothing answer', async () => {
    vi.mocked(getSession).mockResolvedValue(row({ id: 's9', title: '' }))

    expect(await fetchSessionLinkTitle('s9')).toBe('')
    expect(await fetchSessionLinkTitle('s9')).toBe('')
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  // A link to a session on another backend 404s. The chip falls back to its
  // short id; it must never surface an error.
  it('resolves empty when the lookup fails', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('404'))

    expect(await fetchSessionLinkTitle('s9')).toBe('')
  })

  it('resolves empty for an unparseable ref without asking', async () => {
    expect(await fetchSessionLinkTitle('   ')).toBe('')
    expect(getSession).not.toHaveBeenCalled()
  })
})
