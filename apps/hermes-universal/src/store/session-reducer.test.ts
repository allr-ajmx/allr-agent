import { describe, expect, it } from 'vitest'

import type { GatewayEvent } from '@/gateway'
import type { ToolCallPart } from '@/lib/chat-messages'
import { reduceSessionState } from '@/store/session-reducer'
import { type ClientSessionState, emptySessionState } from '@/store/session-state-types'

const event = (type: string): GatewayEvent => ({ type }) as GatewayEvent

const reduce = (state: ClientSessionState, type: string, payload: Record<string, unknown> = {}): ClientSessionState =>
  reduceSessionState(state, event(type), payload)

const toolParts = (state: ClientSessionState): ToolCallPart[] =>
  state.messages.flatMap(message => message.parts.filter((part): part is ToolCallPart => part.type === 'tool-call'))

// MJXHRM-362. A clarify parks the agent in the backend's `_block` until
// `clarify.respond` lands, and the inline panel normally mounts from the earlier
// `tool.start` row. With no placeholder case here, a missed `tool.start` left the
// sidebar saying "needs input" with nowhere to render the question — the turn was
// unanswerable and hung forever.
describe('clarify.request', () => {
  const base = () => ({ ...emptySessionState('stored-1'), busy: true })

  it('inserts a synthetic clarify tool-call row keyed on the request id', () => {
    const next = reduce(base(), 'clarify.request', {
      request_id: 'req-1',
      question: 'Which branch?',
      choices: ['main', 'develop']
    })

    expect(next.needsInput).toBe(true)
    expect(toolParts(next)).toEqual([
      expect.objectContaining({
        toolCallId: 'req-1',
        toolName: 'clarify',
        args: { choices: ['main', 'develop'], question: 'Which branch?' }
      })
    ])
  })

  // The row exists so the question is answerable, not so it lingers: a real
  // tool.start / tool.complete carrying the same request id must MERGE into it.
  it('is merged, not duplicated, by the real tool events for the same id', () => {
    let state = reduce(base(), 'clarify.request', { request_id: 'req-1', question: 'Which branch?' })
    state = reduce(state, 'tool.start', { name: 'clarify', tool_id: 'req-1' })

    expect(toolParts(state)).toHaveLength(1)

    state = reduce(state, 'tool.complete', { name: 'clarify', tool_id: 'req-1', result: 'main' })

    expect(toolParts(state)).toHaveLength(1)
    expect(toolParts(state)[0].toolCallId).toBe('req-1')
  })

  // THE NORMAL PATH, and the one the ids do NOT line up on. `tool.start` carries
  // the model's tool_call_id and lands FIRST; `clarify.request` carries the
  // gateway's own request_id. Correlating on id alone therefore mounts a SECOND
  // clarify card beside the first — two live panels for one blocked question,
  // each with its own global key handler. `question` is the only field both
  // events share (`tool.start` ships it as the truncated `context` preview via
  // `_tool_ctx` → `build_tool_preview`), so it is what has to correlate them.
  it('merges into the tool.start row that arrived first under the model tool id', () => {
    let state = reduce(base(), 'tool.start', {
      name: 'clarify',
      tool_id: 'call_abc123',
      context: 'Which branch?'
    })
    state = reduce(state, 'clarify.request', {
      request_id: 'req-1',
      question: 'Which branch?',
      choices: ['main', 'develop']
    })

    expect(toolParts(state)).toHaveLength(1)
    expect(toolParts(state)[0].args).toMatchObject({ choices: ['main', 'develop'], question: 'Which branch?' })

    state = reduce(state, 'tool.complete', {
      name: 'clarify',
      tool_id: 'call_abc123',
      args: { question: 'Which branch?' },
      result: 'main'
    })

    expect(toolParts(state)).toHaveLength(1)
    expect(toolParts(state)[0].result).toBeDefined()
  })

  // `build_tool_preview` caps `context` at 80 chars, so a long question cannot
  // match the request's full text. The rows still have to be one row.
  it('merges even when the tool.start preview truncated the question', () => {
    const question = `Which branch should I cut ${'the release candidate '.repeat(6)}from?`
    let state = reduce(base(), 'tool.start', {
      name: 'clarify',
      tool_id: 'call_abc123',
      context: question.slice(0, 80)
    })
    state = reduce(state, 'clarify.request', { request_id: 'req-1', question, choices: ['main'] })

    expect(toolParts(state)).toHaveLength(1)
  })

  it('still flags needs-input for a malformed request rather than inventing a row', () => {
    const next = reduce(base(), 'clarify.request', { request_id: 'req-1' })

    expect(next.needsInput).toBe(true)
    expect(toolParts(next)).toEqual([])
  })

  it('drops non-string choices instead of rendering them', () => {
    const next = reduce(base(), 'clarify.request', {
      request_id: 'req-1',
      question: 'Which?',
      choices: ['ok', 3, null]
    })

    expect(toolParts(next)[0].args).toMatchObject({ choices: ['ok'] })
  })

  // The other blocking prompts have their own inline bars and no tool row.
  it('leaves approval / sudo / secret as flag-only', () => {
    for (const type of ['approval.request', 'sudo.request', 'secret.request']) {
      const next = reduce(base(), type, { request_id: 'r', question: 'q' })

      expect(next.needsInput).toBe(true)
      expect(toolParts(next)).toEqual([])
    }
  })
})
