import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hasClarifyRequest, normalizeChoices, readChoices, skipClarifyRequest } from '@/store/clarify'
import { clearAllPrompts, sessionClarifyRequest, setSessionClarify } from '@/store/prompts'

vi.mock('@/store/gateway', () => ({
  $gatewayState: { get: () => 'open', subscribe: () => () => {} },
  requestGateway: vi.fn(() => Promise.resolve({}))
}))

const { requestGateway } = await import('@/store/gateway')

beforeEach(() => {
  clearAllPrompts()
  vi.mocked(requestGateway).mockClear()
  vi.mocked(requestGateway).mockResolvedValue({})
})

describe('normalizeChoices', () => {
  it('keeps ordinary options', () => {
    expect(normalizeChoices(['staging', 'prod'])).toEqual(['staging', 'prod'])
  })

  // A choice list comes out of a model's tool call. Each of these renders
  // badly and cannot be recovered from once on screen.
  it('drops blank, multi-line and over-long entries', () => {
    expect(normalizeChoices(['ok', '', '   ', 'two\nlines', 'x'.repeat(201)])).toEqual(['ok'])
  })

  it('drops non-strings and a non-array payload', () => {
    expect(normalizeChoices(['ok', 42, null, { a: 1 }])).toEqual(['ok'])
    expect(normalizeChoices('staging')).toEqual([])
    expect(normalizeChoices(undefined)).toEqual([])
  })

  it('keeps a choice exactly at the length limit', () => {
    expect(normalizeChoices(['x'.repeat(200)])).toHaveLength(1)
  })
})

describe('readChoices', () => {
  it('returns null rather than an empty list, so the panel falls back to free text', () => {
    expect(readChoices('gateway', 'q', [])).toBeNull()
    expect(readChoices('gateway', 'q', undefined)).toBeNull()
  })

  // Degrading silently to a free-text box looks identical to a question the
  // model never offered options for, so a malformed tool call would be invisible.
  it('warns when a non-empty payload normalized away to nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readChoices('tool_args', 'Which target?', ['', '  '])).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockRestore()
  })

  it('does not warn when there were no choices to begin with', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    readChoices('gateway', 'Which target?', undefined)

    expect(warn).not.toHaveBeenCalled()

    warn.mockRestore()
  })
})

describe('skipClarifyRequest', () => {
  it('answers empty and clears the request', async () => {
    setSessionClarify('s1', { requestId: 'req-1', question: 'q', choices: null })

    expect(hasClarifyRequest('s1')).toBe(true)
    expect(await skipClarifyRequest('s1')).toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('clarify.respond', { request_id: 'req-1', answer: '' })
    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  // The tool times out on its own. A failed skip must never swallow the
  // message the user was actually sending.
  it('resolves true even when the RPC fails, and still clears', async () => {
    vi.mocked(requestGateway).mockRejectedValueOnce(new Error('socket down'))
    setSessionClarify('s1', { requestId: 'req-2', question: 'q', choices: null })

    expect(await skipClarifyRequest('s1')).toBe(true)
    expect(sessionClarifyRequest('s1').get()).toBeNull()
  })

  it('is a no-op with nothing parked', async () => {
    expect(await skipClarifyRequest('s1')).toBe(false)
    expect(await skipClarifyRequest(null)).toBe(false)
    expect(requestGateway).not.toHaveBeenCalled()
  })
})
