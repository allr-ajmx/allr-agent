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

  // THE PATH THE ROW EXISTS FOR: `tool.start` was missed (a reconnect, a slice
  // this event created), so the request arrives FIRST and the real tool events
  // land afterwards under the MODEL's id. They have to merge into the synthetic
  // row and settle it, not open a second card.
  //
  // This replaces a test that fed `tool.start` the REQUEST id — an event shape
  // the gateway cannot produce (`_on_tool_start` ships the model's
  // `tool_call_id`) — which made the merge look like a plain id lookup and hid
  // the correlation the real ordering depends on.
  it('is merged, not duplicated, by the real tool events that arrive after it', () => {
    let state = reduce(base(), 'clarify.request', { request_id: 'req-1', question: 'Which branch?' })
    state = reduce(state, 'tool.start', { name: 'clarify', tool_id: 'call_abc123', context: 'Which branch?' })

    expect(toolParts(state)).toHaveLength(1)

    state = reduce(state, 'tool.complete', {
      name: 'clarify',
      tool_id: 'call_abc123',
      args: { question: 'Which branch?' },
      result: 'main'
    })

    expect(toolParts(state)).toHaveLength(1)
    expect(toolParts(state)[0].result).toBeDefined()
  })

  // A turn whose `message.start` was missed leaves `busy` false with a SETTLED
  // assistant last — the state every mid-turn reattach and every hydrate from
  // history is in. `tool.start` merges into that settled bubble
  // (`applyToolEvent`), so a clarify row appended to a fresh PENDING bubble
  // could never merge with it: two live cards for one question, in two
  // different messages, plus a pending bubble nothing settles.
  it('lands in the message the tool events land in when the turn no longer looks live', () => {
    const settled: ClientSessionState = {
      ...emptySessionState('stored-1'),
      busy: false,
      messages: [{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'working on it' }] }]
    }

    let state = reduce(settled, 'tool.start', { name: 'clarify', tool_id: 'call_abc123', context: 'Which branch?' })

    state = reduce(state, 'clarify.request', { request_id: 'req-1', question: 'Which branch?', choices: ['main'] })

    expect(state.messages).toHaveLength(1)
    expect(toolParts(state)).toHaveLength(1)
    expect(toolParts(state)[0].args).toMatchObject({ choices: ['main'], question: 'Which branch?' })
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

/**
 * MJXHRM-357. The gateway's transient narration is `{kind, text}` — every
 * `_emit("status.update", …)` in `tui_gateway/server.py` builds that pair, and
 * `_status_update` is the only builder. This case read `payload.status ||
 * payload.message` (the latter is the ERROR event's key), so every status frame
 * resolved to `''` AND wiped the line, and universal's status row had no live
 * producer at all. The compaction status is the one that matters most: it is the
 * backend saying, in words, that it is summarizing.
 */
describe('status.update', () => {
  const COMPACTING = '🗜️ Compacting context — summarizing earlier conversation so I can continue...'

  it('shows the gateway status text', () => {
    const next = reduce(emptySessionState('stored-1'), 'status.update', { kind: 'compacting', text: COMPACTING })

    expect(next.statusLine).toBe(COMPACTING)
  })

  it('clears the line when the gateway sends an empty status', () => {
    const busy = { ...emptySessionState('stored-1'), statusLine: COMPACTING }
    const next = reduce(busy, 'status.update', { kind: 'status', text: '' })

    expect(next.statusLine).toBe('')
  })
})

/**
 * MJXHRM-304 item 4. `session.info` is the gateway's only report of what a
 * session is actually running, and the ONLY confirmation a mid-turn model pick
 * ever gets: `config.set model` on a busy session parks the pick in
 * `pending_model_switch` and `_session_info` reports it as `display_model`
 * (`tui_gateway/server.py`), precisely so the end-of-turn settle paints the
 * user's choice rather than the model still running. This case took `cwd` and
 * threw the rest away.
 */
describe('session.info', () => {
  const base = () => ({ ...emptySessionState('stored-1'), model: 'old-model', provider: 'old-provider' })

  it('adopts the model the gateway reports — including a pick queued mid-turn', () => {
    const next = reduce(base(), 'session.info', {
      model: 'glm-5',
      provider: 'zai',
      reasoning_effort: 'high',
      service_tier: 'priority',
      fast: true,
      running: true
    })

    expect(next).toMatchObject({
      model: 'glm-5',
      provider: 'zai',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      fast: true
    })
  })

  // The gateway reports '' for "not known yet" — a session whose agent is still
  // building has no `agent.model`. Blanking a painted model on that is worse
  // than keeping a slightly stale one, so model/provider/cwd are truthy-gated.
  it('keeps a painted model when the gateway reports a blank one', () => {
    const next = reduce(base(), 'session.info', { cwd: '', model: '', provider: '' })

    expect(next).toMatchObject({ model: 'old-model', provider: 'old-provider' })
  })

  // '' and false are REAL states for these three ("provider default", "not
  // fast"), so they must land where a blank model must not.
  it('adopts an empty effort and a false fast, which are real values', () => {
    const on = { ...base(), fast: true, reasoningEffort: 'high', serviceTier: 'priority' }
    const next = reduce(on, 'session.info', { reasoning_effort: '', service_tier: '', fast: false })

    expect(next).toMatchObject({ fast: false, reasoningEffort: '', serviceTier: '' })
  })

  // `session.info` rides every turn boundary and every config write. Returning a
  // fresh object for one that carries no news republishes $sessionStates and
  // re-renders every chat surface for nothing.
  it('returns the same state object when nothing changed', () => {
    const state = { ...base(), cwd: '/w', fast: false, reasoningEffort: '', serviceTier: '' }

    const next = reduce(state, 'session.info', {
      cwd: '/w',
      model: 'old-model',
      provider: 'old-provider',
      reasoning_effort: '',
      service_tier: '',
      fast: false
    })

    expect(next).toBe(state)
  })
})

/**
 * The clarify tool RETURNING is this session's "no longer parked on the user".
 * It is the one event shared by all three endings — the user answered, the
 * backend's `_block` timed out, `session.interrupt` released it — and
 * `needsInput` was otherwise cleared only by `message.complete`, so the sidebar
 * kept the attention dot lit (and the running arc suppressed) for the whole rest
 * of a turn the user had already unblocked.
 */
describe('clarify completion', () => {
  it('stops flagging needs-input when the clarify tool returns', () => {
    let state = reduce({ ...emptySessionState('stored-1'), busy: true }, 'clarify.request', {
      request_id: 'req-1',
      question: 'Which branch?'
    })

    expect(state.needsInput).toBe(true)

    state = reduce(state, 'tool.complete', {
      name: 'clarify',
      tool_id: 'call_abc123',
      args: { question: 'Which branch?' },
      result: 'main'
    })

    expect(state.needsInput).toBe(false)
    expect(state.busy).toBe(true)
  })

  // Another tool finishing says nothing about the prompt: an approval parked on
  // a different tool is still parked.
  it('leaves needs-input alone when a different tool returns', () => {
    let state = reduce({ ...emptySessionState('stored-1'), busy: true }, 'approval.request', { command: 'rm -rf /' })

    state = reduce(state, 'tool.complete', { name: 'bash', tool_id: 'call_x', result: 'ok' })

    expect(state.needsInput).toBe(true)
  })
})
