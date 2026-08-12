import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ToolCallPart } from '@/lib/chat-messages'
import {
  applyResumedClarify,
  hasClarifyRequest,
  matchClarifyRequest,
  normalizeChoices,
  readChoices,
  skipClarifyRequest
} from '@/store/clarify'
import { clearAllPrompts, sessionClarifyRequest, setSessionClarify } from '@/store/prompts'
import { reduceSessionState } from '@/store/session-reducer'
import { $sessionStates, emptySessionState, publishSessionState } from '@/store/session-state-types'

vi.mock('@/store/gateway', () => ({
  $gatewayState: { get: () => 'open', subscribe: () => () => {} },
  requestGateway: vi.fn(() => Promise.resolve({}))
}))

const { requestGateway } = await import('@/store/gateway')

beforeEach(() => {
  clearAllPrompts()
  $sessionStates.set({})
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

describe('matchClarifyRequest', () => {
  const request = { requestId: 'req-1', question: 'Which branch?', choices: null }

  it('matches when the row carries no question of its own', () => {
    expect(matchClarifyRequest(request, '')).toBe(request)
  })

  it('matches the row asking the same question', () => {
    expect(matchClarifyRequest(request, 'Which branch?')).toBe(request)
  })

  // An old clarify row whose `tool.complete` was lost must not offer to answer
  // the NEW question parked on the session.
  it('rejects a row asking a different question', () => {
    expect(matchClarifyRequest(request, 'Which region?')).toBeNull()
  })

  it('is null with nothing parked', () => {
    expect(matchClarifyRequest(null, 'Which branch?')).toBeNull()
    expect(matchClarifyRequest(undefined, '')).toBeNull()
  })
})

const toolParts = (key: string): ToolCallPart[] =>
  ($sessionStates.get()[key]?.messages ?? []).flatMap(message =>
    message.parts.filter((part): part is ToolCallPart => part.type === 'tool-call')
  )

/**
 * MJXHRM-362. `clarify.request` is emitted ONCE and never buffered, and a turn
 * parked in the backend's `_block` is in no committed transcript — so a client
 * that cold-opens a waiting session had neither the question nor the
 * `request_id`, and the agent stayed parked until its timeout with nothing on
 * screen but a "needs input" dot. The gateway now describes the parked prompt on
 * `session.resume` (`_session_pending_prompt`), and this puts it back.
 */
describe('applyResumedClarify', () => {
  const pending = (payload: Record<string, unknown>, event = 'clarify.request') => ({
    pending_prompt: { event, payload }
  })

  beforeEach(() => {
    publishSessionState('s1', { ...emptySessionState('stored-1'), busy: true })
  })

  it('rebuilds both the answerable request and the transcript row', () => {
    applyResumedClarify('s1', pending({ request_id: 'req-1', question: 'Which branch?', choices: ['main', 'dev'] }))

    expect(sessionClarifyRequest('s1').get()).toEqual({
      requestId: 'req-1',
      question: 'Which branch?',
      choices: ['main', 'dev']
    })
    expect(toolParts('s1')).toEqual([
      expect.objectContaining({
        toolCallId: 'req-1',
        toolName: 'clarify',
        args: { choices: ['main', 'dev'], question: 'Which branch?' }
      })
    ])
    expect($sessionStates.get().s1?.needsInput).toBe(true)
  })

  // A WARM reconnect still holds the card it built from the live event. The
  // replay must upsert onto it, not stack a second one.
  it('leaves one card when the session already showed the same clarify', () => {
    const payload = { request_id: 'req-1', question: 'Which branch?', choices: ['main'] }

    publishSessionState(
      's1',
      reduceSessionState($sessionStates.get().s1!, { type: 'clarify.request' } as never, payload)
    )

    applyResumedClarify('s1', pending(payload))

    expect(toolParts('s1')).toHaveLength(1)
  })

  it('ignores a prompt that is not a clarify', () => {
    applyResumedClarify('s1', pending({ request_id: 'req-1', prompt: 'password:' }, 'sudo.request'))

    expect(sessionClarifyRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })

  it('ignores a session with no prompt parked, and a malformed one', () => {
    applyResumedClarify('s1', {})
    applyResumedClarify('s1', { pending_prompt: null })
    applyResumedClarify('s1', pending({ request_id: 'req-1' }))

    expect(sessionClarifyRequest('s1').get()).toBeNull()
    expect(toolParts('s1')).toEqual([])
  })
})
