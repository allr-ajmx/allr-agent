import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('idle')
  }
})
import { flushDeltas } from '@/lib/stream-batch'
import { routeGatewayEvent as handleGatewayEvent } from '@/store/event-router'
import { requestGateway } from '@/store/gateway'
import { $currentFastMode, $currentModel, $currentProvider, $currentReasoningEffort } from '@/store/model'
import { $petActivity } from '@/store/pet'
import { $activeProfile } from '@/store/profiles'
import { $activeSessionAwaitingInput, sessionApprovalRequest, sessionClarifyRequest } from '@/store/prompts'
import { $sessionStates, newDraftKey, rekeySession, updateSession } from '@/store/session-state-types'
import { $subagentsBySession } from '@/store/subagents'
import { beginTurn, getInflightTurn } from '@/store/turn-lifecycle'
import { resetSessionStates, seedActiveSession, seedSession, sessionMessages } from '@/test-sessions'

vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))
import { burstVibeHearts } from '@/components/chat/vibe-hearts'

vi.mock('@/store/notifications', () => ({
  clearNotifications: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn()
}))
import { notifyError } from '@/store/notifications'

import {
  $approval,
  $busy,
  $clarify,
  $currentCwd,
  $messages,
  $secret,
  $sessionId,
  $statusLine,
  $sudo,
  type ChatMessage,
  ensureSession,
  interruptSession,
  noteMissedSteer,
  redirectPrompt,
  resetChat,
  respondApproval,
  respondClarify,
  respondSecret,
  respondSudo,
  restoreToMessage,
  sendPrompt,
  submitEditedPrompt
} from './chat'

const ev = (type: string, payload: Record<string, unknown>): GatewayEvent =>
  ({ type, payload }) as unknown as GatewayEvent

const messageText = (message: ChatMessage): string =>
  message.parts.map(part => (part.type === 'text' ? part.text : '')).join('')

beforeEach(() => {
  resetSessionStates()
  resetChat()
  // Most of these tests drive the reducer directly, so give the active session a
  // real key: the router FAILS CLOSED on unknown sessions, and unscoped events
  // resolve to whatever `$activeSessionKey` names.
  seedActiveSession('runtime-1')
  vi.mocked(requestGateway).mockReset()
  vi.mocked(burstVibeHearts).mockReset()
  vi.mocked(notifyError).mockReset()
})

describe('reaction events', () => {
  it('bursts hearts for a vibe reaction on the visible session', () => {
    handleGatewayEvent(ev('reaction', { kind: 'vibe' }))

    expect(burstVibeHearts).toHaveBeenCalledTimes(1)
  })

  it('defaults a reaction with no kind to vibe', () => {
    handleGatewayEvent(ev('reaction', {}))

    expect(burstVibeHearts).toHaveBeenCalledTimes(1)
  })

  it('ignores reaction kinds it has no renderer for', () => {
    handleGatewayEvent(ev('reaction', { kind: 'confetti' }))

    expect(burstVibeHearts).not.toHaveBeenCalled()
  })

  it('stays quiet for a background session, so only the visible chat reacts', () => {
    // A KNOWN session that simply isn't the one on screen — the router folds its
    // events in, but hearts sit behind the active-session gate.
    seedSession('runtime-2')

    handleGatewayEvent({ type: 'reaction', session_id: 'runtime-2', payload: { kind: 'vibe' } } as GatewayEvent)

    expect(burstVibeHearts).not.toHaveBeenCalled()
  })
})

describe('chat reducer (parts model)', () => {
  it('builds text + reasoning + tool parts from a stream', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('message.delta', { text: 'Hel' }))
    handleGatewayEvent(ev('message.delta', { text: 'lo' }))
    handleGatewayEvent(ev('reasoning.delta', { text: 'hmm' }))
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 't1', args: { q: 'x' } }))
    handleGatewayEvent(ev('tool.complete', { tool_id: 't1', result: 'done' }))
    handleGatewayEvent(ev('message.complete', { text: 'Hello' }))

    const msgs = $messages.get()
    expect(msgs).toHaveLength(1)
    const m = msgs[0]
    expect(m.role).toBe('assistant')
    expect(m.pending).toBe(false)
    expect(m.parts.find(p => p.type === 'text')).toMatchObject({ type: 'text', text: 'Hello' })
    expect(m.parts.find(p => p.type === 'reasoning')).toMatchObject({ type: 'reasoning', text: 'hmm' })
    // The result is always normalized to an OBJECT (see lib/chat-tool-parts):
    // `result === undefined` is what marks a row as still running, and a plain
    // string result is kept under `output` so nothing is lost.
    expect(m.parts.find(p => p.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      toolName: 'grep',
      result: { output: 'done' }
    })
  })

  it('coalesces consecutive same-channel deltas into one part', () => {
    handleGatewayEvent(ev('message.delta', { text: 'a' }))
    handleGatewayEvent(ev('message.delta', { text: 'b' }))
    // Deltas are batched (lib/stream-batch), so they reach the transcript on a
    // flush rather than per token. Every non-delta event flushes first, which is
    // why the other reducer tests don't need this.
    flushDeltas()
    const texts = $messages.get()[0].parts.filter(p => p.type === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'ab' })
  })

  it('reasoning.available replaces the tail reasoning part', () => {
    handleGatewayEvent(ev('reasoning.delta', { text: 'draft' }))
    handleGatewayEvent(ev('reasoning.available', { text: 'final' }))
    const reasoning = $messages.get()[0].parts.filter(p => p.type === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ text: 'final' })
  })

  it('lands the completion text when the reply never streamed as message.delta', () => {
    // Providers that only stream their reasoning channel deliver the answer
    // whole on message.complete. Without this the transcript showed the reply
    // inside a "Thinking" block and no prose until the chat was reloaded.
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('reasoning.delta', { text: 'The answer is 42.' }))
    handleGatewayEvent(ev('message.complete', { text: 'The answer is 42.' }))

    const parts = $messages.get()[0].parts
    expect(parts.filter(p => p.type === 'reasoning')).toHaveLength(0)
    expect(parts.filter(p => p.type === 'text')).toMatchObject([{ text: 'The answer is 42.' }])
  })

  it('keeps genuine reasoning and completes a truncated stream in place', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('reasoning.delta', { text: 'let me count' }))
    handleGatewayEvent(ev('message.delta', { text: 'The answer ' }))
    handleGatewayEvent(ev('message.complete', { text: 'The answer is 42.' }))

    const parts = $messages.get()[0].parts
    expect(parts.filter(p => p.type === 'reasoning')).toMatchObject([{ text: 'let me count' }])
    expect(parts.filter(p => p.type === 'text')).toMatchObject([{ text: 'The answer is 42.' }])
  })

  it('keeps the streamed partial when an interrupted turn completes with no text', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('message.delta', { text: 'half a th' }))
    handleGatewayEvent(ev('message.complete', { text: '' }))

    const message = $messages.get()[0]
    expect(message.pending).toBe(false)
    expect(message.parts).toMatchObject([{ type: 'text', text: 'half a th' }])
  })

  it('surfaces a provider failure delivered as completion text as an inline error', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('message.complete', { text: 'API call failed after 3 retries: overloaded' }))

    const message = $messages.get()[0]
    expect(message.error).toBe('API call failed after 3 retries: overloaded')
    expect(message.parts.filter(p => p.type === 'text')).toHaveLength(0)
  })

  it('routes approval / clarify / sudo / secret to their atoms with request_id', () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm', description: 'danger' }))
    expect($approval.get()).toMatchObject({ command: 'rm', description: 'danger' })
    // The gateway sends `question` + `choices` (tui_gateway/server.py `_agent_cbs`),
    // NOT `prompt` — reading the wrong key left the inline panel with no question.
    handleGatewayEvent(ev('clarify.request', { request_id: 'c1', question: 'which file?', choices: ['a.ts', 'b.ts'] }))
    expect($clarify.get()).toMatchObject({ requestId: 'c1', question: 'which file?', choices: ['a.ts', 'b.ts'] })
    handleGatewayEvent(ev('sudo.request', { request_id: 's1', prompt: 'password?' }))
    expect($sudo.get()).toMatchObject({ requestId: 's1', prompt: 'password?' })
    handleGatewayEvent(ev('secret.request', { request_id: 'x1', env_var: 'API_KEY', prompt: 'key?' }))
    expect($secret.get()).toMatchObject({ requestId: 'x1', envVar: 'API_KEY' })
  })

  it('keeps an open-ended clarify (no choices) and ignores one with no question', () => {
    handleGatewayEvent(ev('clarify.request', { request_id: 'c2', question: 'anything else?' }))
    expect($clarify.get()).toMatchObject({ requestId: 'c2', question: 'anything else?', choices: null })
    // A malformed request must not clobber the live one — the agent is blocked
    // on the first, and a questionless panel is unanswerable.
    handleGatewayEvent(ev('clarify.request', { request_id: 'c3' }))
    expect($clarify.get()).toMatchObject({ requestId: 'c2' })
  })

  it('carries the approval choice restrictions through to the atom', () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /', choices: ['once', 'deny'], smart_denied: true }))
    expect($approval.get()).toMatchObject({ choices: ['once', 'deny'], smartDenied: true })
  })

  it('respondClarify posts clarify.respond with the request_id + answer and clears the atom', async () => {
    handleGatewayEvent(ev('clarify.request', { request_id: 'c9', question: 'which?', choices: ['x'] }))
    await respondClarify('x')
    expect(requestGateway).toHaveBeenCalledWith('clarify.respond', { request_id: 'c9', answer: 'x' })
    expect($clarify.get()).toBeNull()
  })

  it('keeps the clarify request pending when the send fails', async () => {
    handleGatewayEvent(ev('clarify.request', { request_id: 'c10', question: 'which?', choices: ['x'] }))
    vi.mocked(requestGateway).mockRejectedValueOnce(new Error('offline'))
    await expect(respondClarify('x')).rejects.toThrow('offline')
    expect($clarify.get()).toMatchObject({ requestId: 'c10' })
  })

  // `clarify.respond` is `allow_expired` on the backend: a request its own
  // 5-minute timeout already popped answers `{"status": "expired"}` — an RPC
  // SUCCESS that delivered nothing. Reporting that as a normal send is how an
  // answer disappears with the UI saying it went through.
  it('reports an answer the backend had already timed out as expired', async () => {
    handleGatewayEvent(ev('clarify.request', { request_id: 'c11', question: 'which?', choices: ['x'] }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'expired' } as never)

    await expect(respondClarify('x')).resolves.toBe('expired')
    // Nothing will ever answer it now, so the panel does not keep it alive.
    expect($clarify.get()).toBeNull()
  })

  it('reports a live answer as delivered', async () => {
    handleGatewayEvent(ev('clarify.request', { request_id: 'c12', question: 'which?', choices: ['x'] }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'ok' } as never)

    await expect(respondClarify('x')).resolves.toBe('delivered')
  })

  it('respondSudo posts sudo.respond with the request_id + password and clears the atom', async () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's9', prompt: 'pw' }))
    await respondSudo('hunter2')
    expect(requestGateway).toHaveBeenCalledWith('sudo.respond', { request_id: 's9', password: 'hunter2' })
    expect($sudo.get()).toBeNull()
  })

  // MJXHRM-418: these three cleared the request BEFORE the send and swallowed
  // the rejection, so a failed answer read as "accepted" while the agent stayed
  // blocked until its timeout — with the prompt gone and no way to re-answer.
  it('keeps the sudo request pending and throws when the send fails', async () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's10', prompt: 'pw' }))
    vi.mocked(requestGateway).mockRejectedValueOnce(new Error('offline'))
    await expect(respondSudo('hunter2')).rejects.toThrow('offline')
    expect($sudo.get()).toMatchObject({ requestId: 's10' })
  })

  it('keeps the secret request pending and throws when the send fails', async () => {
    handleGatewayEvent(ev('secret.request', { request_id: 'x10', env_var: 'API_KEY', prompt: 'key?' }))
    vi.mocked(requestGateway).mockRejectedValueOnce(new Error('offline'))
    await expect(respondSecret('sk-1')).rejects.toThrow('offline')
    expect($secret.get()).toMatchObject({ requestId: 'x10' })
  })

  it('keeps the approval request pending and throws when the send fails', async () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    vi.mocked(requestGateway).mockRejectedValue(new Error('offline'))
    await expect(respondApproval('once')).rejects.toThrow('offline')
    expect($approval.get()).toMatchObject({ command: 'rm -rf /' })
  })

  it('respondApproval names the session the slice actually holds, and clears on success', async () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    await respondApproval('once')
    // It used to send `session_id: undefined` whenever the slice had no runtime
    // id — which the gateway answers with the very "session not found" the old
    // swallow then hid.
    expect(requestGateway).toHaveBeenCalledWith('approval.respond', { choice: 'once', session_id: 'runtime-1' })
    expect($approval.get()).toBeNull()
  })

  // MJXHRM-418, second pass. A rejection is only half of "the gateway did not
  // take this answer": each of these RPCs also has a SUCCESS that delivers
  // nothing, and reporting that as a normal send is the same lie the swallowed
  // rejection was.

  // `approval.respond` returns the COUNT of parked agent threads it unblocked
  // (`resolve_gateway_approval`). Zero means the five-minute approval timeout,
  // a /stop, or another surface already took the request off the queue — the
  // command was BLOCKED and this click changed nothing.
  it('reports an approval that unblocked nobody as expired', async () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ resolved: 0 } as never)

    await expect(respondApproval('once')).resolves.toBe('expired')
    // Nothing is waiting for it any more, so the dead bar goes either way.
    expect($approval.get()).toBeNull()
  })

  it('reports an approval that unblocked a waiting tool as delivered', async () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ resolved: 1 } as never)

    await expect(respondApproval('once')).resolves.toBe('delivered')
  })

  // A backend that doesn't report `resolved` is not claiming anything either
  // way; treating the missing field as zero would warn on every send.
  it('does not call an approval expired when the gateway omits the count', async () => {
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({} as never)

    await expect(respondApproval('once')).resolves.toBe('delivered')
  })

  // `sudo.respond` / `secret.respond` are `allow_expired`: a password or value
  // that lands after the tool's own wait gave up is accepted and discarded.
  it('reports a sudo password the tool had stopped waiting for as expired', async () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's11', prompt: 'pw' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'expired' } as never)

    await expect(respondSudo('hunter2')).resolves.toBe('expired')
    expect($sudo.get()).toBeNull()
  })

  it('reports a live sudo password as delivered', async () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's12', prompt: 'pw' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'ok' } as never)

    await expect(respondSudo('hunter2')).resolves.toBe('delivered')
  })

  it('reports a secret the tool had stopped waiting for as expired', async () => {
    handleGatewayEvent(ev('secret.request', { request_id: 'x11', env_var: 'API_KEY', prompt: 'key?' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'expired' } as never)

    await expect(respondSecret('sk-1')).resolves.toBe('expired')
    expect($secret.get()).toBeNull()
  })

  it('reports a live secret as delivered', async () => {
    handleGatewayEvent(ev('secret.request', { request_id: 'x12', env_var: 'API_KEY', prompt: 'key?' }))
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'ok' } as never)

    await expect(respondSecret('sk-1')).resolves.toBe('delivered')
  })

  it('answers nothing when there is no local request left to answer', async () => {
    await expect(respondSudo('hunter2')).resolves.toBe('gone')
    await expect(respondSecret('sk-1')).resolves.toBe('gone')
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

// `_block()` in tui_gateway/server.py emits `<name>.expire` when a blocking
// prompt's wait gives up — the gateway TELLING us the bar on screen is dead.
// Ignoring it left the bar answerable over a cancelled tool AND kept
// `$activeSessionAwaitingInput` true, which is what makes Esc refuse to
// interrupt the rest of the turn.
describe('blocking prompts the gateway says expired', () => {
  it('drops an expired sudo request and stops reporting the turn as parked', () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's20', prompt: 'pw' }))
    expect($activeSessionAwaitingInput.get()).toBe(true)
    // The pet's waiting pose is set by the request and is only ever cleared by
    // ANSWERING one, so an unanswered death used to strand it there.
    expect($petActivity.get().awaitingInput).toBe(true)

    handleGatewayEvent(ev('sudo.expire', { request_id: 's20' }))

    expect($sudo.get()).toBeNull()
    expect($activeSessionAwaitingInput.get()).toBe(false)
    expect($petActivity.get().awaitingInput).toBe(false)
  })

  it('drops an expired secret request', () => {
    handleGatewayEvent(ev('secret.request', { request_id: 'x20', env_var: 'API_KEY', prompt: 'key?' }))
    handleGatewayEvent(ev('secret.expire', { request_id: 'x20' }))

    expect($secret.get()).toBeNull()
  })

  // The expire is matched on request_id: a second prompt that arrived while the
  // first was expiring is still live and must not be torn down with it.
  it('keeps a newer sudo request when a stale expire arrives', () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's21', prompt: 'pw' }))
    handleGatewayEvent(ev('sudo.expire', { request_id: 's20' }))

    expect($sudo.get()).toMatchObject({ requestId: 's21' })
  })

  it('keeps a newer secret request when a stale expire arrives', () => {
    handleGatewayEvent(ev('secret.request', { request_id: 'x21', env_var: 'API_KEY', prompt: 'key?' }))
    handleGatewayEvent(ev('secret.expire', { request_id: 'x20' }))

    expect($secret.get()).toMatchObject({ requestId: 'x21' })
  })

  // An approval is still open on this session, so the turn IS still parked on
  // the user even though the sudo prompt died.
  it('leaves the turn parked when another prompt on the session is still open', () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's22', prompt: 'pw' }))
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    handleGatewayEvent(ev('sudo.expire', { request_id: 's22' }))

    expect($sudo.get()).toBeNull()
    expect($activeSessionAwaitingInput.get()).toBe(true)
    expect($petActivity.get().awaitingInput).toBe(true)
  })
})

describe('tool events outside the live turn', () => {
  // Regression: a trailing tool.complete used to open a brand-new `pending`
  // assistant that nothing ever settled — an orphan bubble spinning forever.
  it('merges a late completion into the finished assistant', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 't1', context: 'needle' }))
    handleGatewayEvent(ev('message.complete', {}))
    handleGatewayEvent(ev('tool.complete', { name: 'grep', tool_id: 't1', result: { matches: 1 } }))

    const msgs = $messages.get()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].pending).toBe(false)
    expect(msgs[0].parts.filter(p => p.type === 'tool-call')).toHaveLength(1)
  })
})

describe('gateway event session routing', () => {
  const sessionEv = (type: string, sessionId: string, payload: Record<string, unknown> = {}): GatewayEvent =>
    ({ type, payload, session_id: sessionId }) as unknown as GatewayEvent

  const toolCalls = (key: string) => sessionMessages(key).flatMap(m => m.parts.filter(p => p.type === 'tool-call'))

  const textOf = (key: string) =>
    sessionMessages(key)
      .flatMap(m => m.parts)
      .map(p => (p.type === 'text' ? p.text : ''))
      .join('')

  it('ignores tool events belonging to another session', () => {
    handleGatewayEvent(sessionEv('message.start', 'runtime-1'))
    handleGatewayEvent(sessionEv('tool.start', 'other-runtime', { name: 'grep', tool_id: 'x1' }))

    expect($messages.get()[0].parts.filter(p => p.type === 'tool-call')).toHaveLength(0)
  })

  it('still reduces events for the active session', () => {
    handleGatewayEvent(sessionEv('message.start', 'runtime-1'))
    handleGatewayEvent(sessionEv('tool.start', 'runtime-1', { name: 'grep', tool_id: 'x1' }))

    expect($messages.get()[0].parts.filter(p => p.type === 'tool-call')).toHaveLength(1)
  })

  // When the gateway does NOT stamp ids, the whole stream pins to whichever
  // session was active at message.start, so a mid-turn chat switch can't drag
  // the old turn's tail into the newly opened transcript.
  it('pins unscoped stream events to the session that started the turn', () => {
    handleGatewayEvent(ev('message.start', {}))
    // The user switches chats mid-turn; the old turn's tail keeps arriving.
    seedActiveSession('runtime-2')
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 'x1' }))

    expect(sessionMessages('runtime-2').some(m => m.parts.some(p => p.type === 'tool-call'))).toBe(false)
    expect(toolCalls('runtime-1')).toHaveLength(1)
  })

  // MJX-132. Two turns in flight at once: each token must accrue to the session
  // that produced it, whichever one happens to be on screen.
  it('keeps two simultaneous streams in their own transcripts', () => {
    seedSession('runtime-2')

    handleGatewayEvent(sessionEv('message.start', 'runtime-1'))
    handleGatewayEvent(sessionEv('message.start', 'runtime-2'))

    for (const [a, b] of [
      ['A1 ', 'B1 '],
      ['A2 ', 'B2 '],
      ['A3', 'B3']
    ]) {
      handleGatewayEvent(sessionEv('message.delta', 'runtime-1', { text: a }))
      handleGatewayEvent(sessionEv('message.delta', 'runtime-2', { text: b }))
    }

    handleGatewayEvent(sessionEv('tool.start', 'runtime-2', { name: 'grep', tool_id: 'b-tool' }))
    handleGatewayEvent(sessionEv('message.complete', 'runtime-1', {}))
    handleGatewayEvent(sessionEv('message.complete', 'runtime-2', {}))

    expect(textOf('runtime-1')).toBe('A1 A2 A3')
    expect(textOf('runtime-2')).toBe('B1 B2 B3')
    expect(toolCalls('runtime-1')).toHaveLength(0)
    expect(toolCalls('runtime-2')).toHaveLength(1)
  })

  // The old guard compared against `$sessionId`, which is null on a draft — so
  // it passed for EVERY foreign session and a background turn painted itself
  // into the empty chat the user was looking at.
  it('leaves a draft chat untouched while another session streams', () => {
    const draft = newDraftKey()
    seedActiveSession(draft, { runtimeSessionId: null, storedSessionId: null })
    seedSession('runtime-2')

    handleGatewayEvent(sessionEv('message.start', 'runtime-2'))
    handleGatewayEvent(sessionEv('message.delta', 'runtime-2', { text: 'not yours' }))
    handleGatewayEvent(sessionEv('message.complete', 'runtime-2', {}))

    expect($sessionId.get()).toBeNull()
    expect($messages.get()).toEqual([])
    expect($busy.get()).toBe(false)
    expect(textOf('runtime-2')).toBe('not yours')
  })

  it('drops events for an unknown session', () => {
    handleGatewayEvent(sessionEv('message.start', 'never-seen'))
    handleGatewayEvent(sessionEv('message.delta', 'never-seen', { text: 'ghost' }))

    expect(sessionMessages('never-seen')).toEqual([])
    expect($messages.get()).toEqual([])
  })

  // ...but a blocking prompt is never dropped: the Python side is parked in
  // `_block` and would hang until its timeout.
  it('still accepts a blocking prompt from an unknown session', () => {
    handleGatewayEvent(sessionEv('clarify.request', 'never-seen', { request_id: 'r1', question: 'which one?' }))

    expect(sessionClarifyRequest('never-seen').get()).toMatchObject({ requestId: 'r1', question: 'which one?' })
  })

  // A late tool event must merge into the owning session's last assistant, and
  // the "is that turn settled?" question must be asked of THAT session — not of
  // a global busy flag another session happens to be driving.
  it('merges a late tool event into the owning settled turn', () => {
    seedSession('runtime-2')

    handleGatewayEvent(sessionEv('message.start', 'runtime-2'))
    handleGatewayEvent(sessionEv('message.delta', 'runtime-2', { text: 'done' }))
    handleGatewayEvent(sessionEv('message.complete', 'runtime-2', {}))

    // runtime-1 is mid-turn, so a global busy flag would say "still streaming".
    handleGatewayEvent(sessionEv('message.start', 'runtime-1'))
    handleGatewayEvent(sessionEv('tool.complete', 'runtime-2', { name: 'grep', tool_id: 'late' }))

    expect(sessionMessages('runtime-2')).toHaveLength(1)
    expect(toolCalls('runtime-2')).toHaveLength(1)
  })

  it('attributes subagent events to the session that spawned them', () => {
    seedSession('runtime-2')
    handleGatewayEvent(sessionEv('subagent.start', 'runtime-2', { agent_id: 'sub-1', name: 'researcher' }))

    expect($subagentsBySession.get()['runtime-1']).toBeUndefined()
    expect($subagentsBySession.get().active).toBeUndefined()
    expect($subagentsBySession.get()['runtime-2']?.length).toBeGreaterThan(0)
  })
})

describe('session.info cwd tracking', () => {
  const sessionEv = (type: string, sessionId: string, payload: Record<string, unknown> = {}): GatewayEvent =>
    ({ type, payload, session_id: sessionId }) as unknown as GatewayEvent

  it('follows the active session relocating itself', () => {
    handleGatewayEvent(sessionEv('session.info', 'runtime-1', { cwd: '/home/me/worktree-b' }))
    expect($currentCwd.get()).toBe('/home/me/worktree-b')
  })

  // The cwd now lives on the slice, so a background session's relocation lands
  // on ITS slice and simply isn't what the active projection reads.
  it('does not move the visible cwd for a background session', () => {
    seedSession('other-runtime')
    updateSession('runtime-1', state => ({ ...state, cwd: '/home/me/project-a' }))

    handleGatewayEvent(sessionEv('session.info', 'other-runtime', { cwd: '/home/me/somewhere-else' }))

    expect($currentCwd.get()).toBe('/home/me/project-a')
  })

  it('applies an unscoped broadcast to the active session', () => {
    handleGatewayEvent(ev('session.info', { cwd: '/home/me/default' }))
    expect($currentCwd.get()).toBe('/home/me/default')
  })

  it('treats an empty cwd as unknown rather than a detach', () => {
    updateSession('runtime-1', state => ({ ...state, cwd: '/home/me/project-a' }))
    handleGatewayEvent(sessionEv('session.info', 'runtime-1', { cwd: '' }))
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })
})

// The last hop of the "start work" hand-off: `startSessionInWorkspace` anchors
// the draft to a just-created worktree, and the session has to be CREATED there.
// Everything upstream of this was covered; the create call itself was not.
describe('ensureSession cwd', () => {
  const seedDraft = (cwd: string) =>
    seedActiveSession(newDraftKey(), { cwd, runtimeSessionId: null, storedSessionId: null })

  it('creates the session in the draft’s anchored directory', async () => {
    seedDraft('/repo/.worktrees/feature-a')
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2' } as never)

    await ensureSession()

    expect(requestGateway).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({ cwd: '/repo/.worktrees/feature-a' })
    )
  })

  // No anchor and no configured default: the gateway resolves its own cwd, so
  // the field is omitted rather than sent empty.
  it('omits cwd entirely for an unanchored draft', async () => {
    seedDraft('')
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-3' } as never)

    await ensureSession()

    expect(vi.mocked(requestGateway).mock.calls[0][1]).not.toHaveProperty('cwd')
  })
})

// The gateway resolves an OMITTED `profile` to its launch profile, so a shared
// remote/cloud gateway put every new chat on "default" whatever the rail showed.
// Branch and resume already carried it; the new-chat path is the one that did
// not. The sticky composer pick rides along as a per-session override — the
// thing `store/model`'s comments promised "the next session.create ships".
describe('ensureSession profile + selection', () => {
  const seedDraft = () => seedActiveSession(newDraftKey(), { runtimeSessionId: null, storedSessionId: null })

  beforeEach(() => {
    $activeProfile.set(null)
    $currentModel.set('')
    $currentProvider.set('')
    $currentReasoningEffort.set('')
    $currentFastMode.set(false)
  })

  it('creates the chat on the active profile with the composer selection as overrides', async () => {
    seedDraft()
    $activeProfile.set('research')
    $currentModel.set('glm-5')
    $currentProvider.set('zai')
    $currentReasoningEffort.set('high')
    $currentFastMode.set(true)
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-4' } as never)

    await ensureSession()

    expect(requestGateway).toHaveBeenCalledWith('session.create', {
      cols: 96,
      source: 'universal',
      profile: 'research',
      model: 'glm-5',
      provider: 'zai',
      reasoning_effort: 'high',
      fast: true
    })
  })

  // Presence is the contract: an omitted profile/model means "inherit", and
  // `fast: false` is a real state (pins normal), so it is always sent.
  it('omits profile and model for the default profile with no pick', async () => {
    seedDraft()
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-5' } as never)

    await ensureSession()

    expect(vi.mocked(requestGateway).mock.calls[0][1]).toEqual({ cols: 96, source: 'universal', fast: false })
  })

  // The composer reads the live slice, so the echo in the create reply is what
  // paints the pill before the deferred agent build's `session.info` lands.
  it('adopts the model the gateway echoes onto the new slice', async () => {
    seedDraft()
    vi.mocked(requestGateway).mockResolvedValue({
      session_id: 'runtime-6',
      info: { model: 'glm-5', provider: 'zai' }
    } as never)

    await ensureSession()

    expect($sessionStates.get()['runtime-6']).toMatchObject({ model: 'glm-5', provider: 'zai' })
  })
})

// MJXHRM-358. A slice that already names a STORED session is not a new chat,
// whatever its runtime binding says. The reconnect path used to leave every
// slice with `runtimeSessionId: null`, and this function answered the next
// message with `session.create` — rekeying the transcript onto a brand-new empty
// session and overwriting its stored id, so the user went on typing into a chat
// whose agent had none of the history still on screen.
describe('ensureSession on a persisted chat with no runtime binding', () => {
  it('rebinds through a resume instead of forking a new session', async () => {
    seedActiveSession('runtime-4', { runtimeSessionId: null, storedSessionId: 'stored-4' })
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-4-new' } as never)

    const out = await ensureSession()

    expect(out).toEqual({ created: false, id: 'runtime-4-new', storedId: 'stored-4' })
    expect(requestGateway).toHaveBeenCalledTimes(1)
    expect(requestGateway).toHaveBeenCalledWith(
      'session.resume',
      expect.objectContaining({ session_id: 'stored-4', omit_messages: true })
    )
    // Rekeyed, so the router addresses the slice by the id the gateway will
    // stamp on the reply.
    expect($sessionStates.get()['runtime-4']).toBeUndefined()
    expect($sessionStates.get()['runtime-4-new']).toMatchObject({
      runtimeSessionId: 'runtime-4-new',
      storedSessionId: 'stored-4'
    })
  })

  // A resume that yields nothing must NOT fall through to `session.create`:
  // surfacing the failure rolls the turn back, forking the conversation does not.
  it('throws rather than falling through to session.create', async () => {
    seedActiveSession('runtime-5', { runtimeSessionId: null, storedSessionId: 'stored-5' })
    vi.mocked(requestGateway).mockResolvedValue({} as never)

    await expect(ensureSession()).rejects.toThrow(/stored-5/)
    expect(requestGateway).not.toHaveBeenCalledWith('session.create', expect.anything())
  })
})

describe('reasoning blocks across a multi-step turn', () => {
  const reasoningTexts = () =>
    $messages
      .get()
      .flatMap(m => m.parts)
      .filter((p): p is Extract<typeof p, { type: 'reasoning' }> => p.type === 'reasoning')
      .map(p => p.text)

  // Each model step can emit its own scratchpad burst (`reasoning.available`,
  // agent/conversation_loop.py). A later burst must never overwrite an earlier
  // thinking block that prose has already followed.
  it('keeps an earlier thinking block once narration follows it', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('reasoning.available', { text: 'think 1' }))
    handleGatewayEvent(ev('message.delta', { text: 'Checking the repo.' }))
    handleGatewayEvent(ev('reasoning.available', { text: 'think 2' }))

    expect(reasoningTexts()).toEqual(['think 1', 'think 2'])
  })

  it('still replaces the live block while the same burst is streaming', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('reasoning.delta', { text: 'partial thou' }))
    handleGatewayEvent(ev('reasoning.available', { text: 'partial thought, complete' }))

    expect(reasoningTexts()).toEqual(['partial thought, complete'])
  })

  it('drops a final burst the stream already showed', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('reasoning.delta', { text: 'a long thought that streamed in full' }))
    handleGatewayEvent(ev('message.delta', { text: 'Answer.' }))
    // The gateway caps `reasoning.available` at 500 chars, so the burst is a
    // prefix of what already streamed — not a second thinking block.
    handleGatewayEvent(ev('reasoning.available', { text: 'a long thought that streamed' }))

    expect(reasoningTexts()).toEqual(['a long thought that streamed in full'])
  })

  it('strips the kawaii spinner prefix and placeholder echoes', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('reasoning.delta', { text: '◉_◉ processing... weighing the options' }))
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 'z1' }))
    handleGatewayEvent(ev('reasoning.delta', { text: "I don't see any current thinking to rewrite" }))

    expect(reasoningTexts()).toEqual(['weighing the options'])
  })
})

describe('submitEditedPrompt (edit + rewind)', () => {
  const seedTurns = () => {
    seedActiveSession('runtime-1', {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first ask' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second ask' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second answer' }] }
      ]
    })
  }

  it('truncates at the edited turn and re-runs it with the new text', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockResolvedValue({})

    await submitEditedPrompt('u2', 'second ask, revised')

    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      // ordinal 1 == the second user turn: it and everything after are dropped.
      // `confirm_truncate` is what makes the gateway act on the ordinal at all —
      // `methods_prompt.py` refuses an unconfirmed one with 4029, so without it
      // EVERY rewind in the app failed and rolled back (universal ported only the
      // `confirm_empty_truncate` half of desktop's `truncateSubmitParams`).
      expect.objectContaining({
        confirm_truncate: true,
        text: 'second ask, revised',
        truncate_before_user_ordinal: 1
      }),
      expect.anything()
    )
    expect($messages.get().map(m => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(messageText($messages.get()[2])).toBe('second ask, revised')
    expect($busy.get()).toBe(true)
  })

  it('interrupts the live turn before resubmitting', async () => {
    seedTurns()
    updateSession('runtime-1', state => ({ ...state, busy: true }))
    vi.mocked(requestGateway).mockResolvedValue({})

    await submitEditedPrompt('u1', 'first ask, revised')

    expect(vi.mocked(requestGateway).mock.calls[0][0]).toBe('session.interrupt')
    expect(vi.mocked(requestGateway).mock.calls[1][0]).toBe('prompt.submit')
  })

  // `session.interrupt` returns BEFORE the provider actually stops, so the
  // submit that follows it can still land on a running session. The gateway
  // refuses to fold a truncating submit into its busy path — steering would hand
  // the text to the very turn being discarded, queueing would run it later with
  // the truncation dropped, and both answer OK — so it says "session busy" and
  // this waits the turn out instead of failing the rewind on the first bounce.
  it('waits out a turn that is still winding down after the interrupt', async () => {
    seedTurns()
    updateSession('runtime-1', state => ({ ...state, busy: true }))

    let submitAttempts = 0

    vi.mocked(requestGateway).mockImplementation(async (method: string) => {
      if (method !== 'prompt.submit') {
        return {}
      }

      submitAttempts += 1

      if (submitAttempts < 3) {
        throw new Error('session busy — interrupt the current turn before rewinding it')
      }

      return {}
    })

    await submitEditedPrompt('u2', 'second ask, revised')

    expect(submitAttempts).toBe(3)
    // The truncation stands: the rewind actually landed.
    expect($messages.get().map(m => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect(vi.mocked(requestGateway).mock.calls.at(-1)?.[1]).toMatchObject({
      confirm_truncate: true,
      truncate_before_user_ordinal: 1
    })
  })

  it('resubmits a failed turn plainly, with no truncate ordinal', async () => {
    seedActiveSession('runtime-1', {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'ask' }] },
        { id: 'a1', role: 'assistant', parts: [], error: 'provider exploded' }
      ]
    })
    vi.mocked(requestGateway).mockResolvedValue({})

    await submitEditedPrompt('u1', 'ask again')

    expect(vi.mocked(requestGateway).mock.calls[0][1]).not.toHaveProperty('truncate_before_user_ordinal')
  })

  // REGRESSION: assistant-ui addresses the edit by message id. When the runtime
  // converter dropped our ids (app/chat/runtime.tsx), `sourceId` was a generated
  // id that never matched, so Enter after an edit silently did nothing.
  //
  // It must still submit nothing — but it must SAY so. The user typed a
  // replacement and pressed Enter; the words leave with the editor either way,
  // and swallowing it is how the runtime bug above stayed invisible.
  it('reports a source id that is not in the transcript instead of silently dropping the edit', async () => {
    seedTurns()

    await submitEditedPrompt('not-a-real-id', 'revised')

    expect(requestGateway).not.toHaveBeenCalled()
    expect($messages.get()).toHaveLength(4)
    expect(notifyError).toHaveBeenCalled()
  })

  it('ignores a no-op edit and a non-user target', async () => {
    seedTurns()

    await submitEditedPrompt('u2', '  second ask  ')
    await submitEditedPrompt('a1', 'not a prompt')

    expect(requestGateway).not.toHaveBeenCalled()
    expect($messages.get()).toHaveLength(4)
    // Both targets resolved; there is simply nothing to send. Not an error.
    expect(notifyError).not.toHaveBeenCalled()
  })

  // Every user bubble in the app is an edit trigger, and a session TILE mounts
  // the same thread (app/chat/session-tile.tsx). This used to read the ACTIVE
  // chat's transcript and runtime id, so a tile's edit rewound the main pane —
  // and because hydrated ids are positional (`h${index}-${role}`), the tile's id
  // RESOLVED there, truncating a conversation the user was not editing and
  // re-running the tile's text into it.
  it('rewinds the session it was handed, not the one on screen', async () => {
    seedActiveSession('runtime-main', {
      messages: [
        { id: 'h0-user', role: 'user', parts: [{ type: 'text', text: 'main first ask' }] },
        { id: 'h1-assistant', role: 'assistant', parts: [{ type: 'text', text: 'main answer' }] },
        { id: 'h2-user', role: 'user', parts: [{ type: 'text', text: 'main second ask' }] },
        { id: 'h3-assistant', role: 'assistant', parts: [{ type: 'text', text: 'main second answer' }] }
      ]
    })
    seedSession('runtime-tile', {
      messages: [
        { id: 'h0-user', role: 'user', parts: [{ type: 'text', text: 'tile first ask' }] },
        { id: 'h1-assistant', role: 'assistant', parts: [{ type: 'text', text: 'tile answer' }] },
        { id: 'h2-user', role: 'user', parts: [{ type: 'text', text: 'tile second ask' }] },
        { id: 'h3-assistant', role: 'assistant', parts: [{ type: 'text', text: 'tile second answer' }] }
      ]
    })
    vi.mocked(requestGateway).mockResolvedValue({})

    await submitEditedPrompt('h2-user', 'tile second ask, revised', 'runtime-tile')

    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ session_id: 'runtime-tile', text: 'tile second ask, revised' }),
      expect.anything()
    )
    expect(sessionMessages('runtime-tile').map(m => m.id)).toEqual(['h0-user', 'h1-assistant', 'h2-user'])
    // The chat on screen is untouched — no truncation, no busy, no re-run.
    expect(sessionMessages('runtime-main').map(m => m.id)).toEqual([
      'h0-user',
      'h1-assistant',
      'h2-user',
      'h3-assistant'
    ])
    expect($busy.get()).toBe(false)
  })

  // `wasBusy` decides whether the rewind interrupts first. Read off the visible
  // chat it answered for the wrong session in both directions: interrupting a
  // tile that was idle, or skipping the interrupt its own live turn needed.
  it('interrupts by the target session’s own busy state, not the visible chat’s', async () => {
    seedActiveSession('runtime-main', { busy: true, messages: [] })
    seedSession('runtime-tile', {
      busy: false,
      messages: [{ id: 'h0-user', role: 'user', parts: [{ type: 'text', text: 'tile ask' }] }]
    })
    vi.mocked(requestGateway).mockResolvedValue({})

    await submitEditedPrompt('h0-user', 'tile ask, revised', 'runtime-tile')

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual(['prompt.submit'])
  })

  it('restores the original transcript when the gateway rejects', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockRejectedValue(new Error('nope'))

    await submitEditedPrompt('u2', 'second ask, revised')

    expect($messages.get().map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(messageText($messages.get()[2])).toBe('second ask')
    expect($busy.get()).toBe(false)
  })

  // The gateway rejects an out-of-range ordinal (4018) BEFORE it truncates
  // anything, so the backend still holds the whole transcript and the plain
  // resend appends at its tail. Leaving the optimistic truncation up therefore
  // showed a thread the backend did not have — invisible until the next
  // hydration, when the "deleted" turns all came back and the edit read as a
  // duplicate. Client and backend have to agree the moment the resend lands.
  it('falls back to a plain resend when the truncate target is stale, and un-truncates to match', async () => {
    seedTurns()
    vi.mocked(requestGateway)
      .mockRejectedValueOnce(new Error('turn is no longer in session history'))
      .mockResolvedValueOnce({})

    await submitEditedPrompt('u2', 'second ask, revised')

    expect(vi.mocked(requestGateway).mock.calls[1][1]).not.toHaveProperty('truncate_before_user_ordinal')
    expect(vi.mocked(requestGateway).mock.calls[1][1]).not.toHaveProperty('confirm_truncate')

    const ids = $messages.get().map(m => m.id)
    // The full history is back, with the edited text appended as the new turn
    // the gateway is about to persist — not grafted onto a cut that never
    // happened.
    expect(ids.slice(0, 4)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(ids).toHaveLength(5)
    expect(messageText($messages.get()[2])).toBe('second ask')
    expect(messageText($messages.get()[4])).toBe('second ask, revised')
  })

  // MJXHRM-367: every other submit path recovers a runtime the gateway dropped;
  // this one did not, and a rewind is the LONGEST-idle submit in the app (read
  // the reply, think, then edit) — the one most likely to be holding a dead id.
  it('recovers a dead runtime mid-rewind and retries on the fresh id', async () => {
    seedTurns()

    vi.mocked(requestGateway).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session.resume') {
        return { session_id: 'runtime-2' }
      }

      if (params?.session_id === 'runtime-1') {
        throw new Error('session not found: runtime-1')
      }

      return {}
    })

    await submitEditedPrompt('u2', 'second ask, revised')

    // The retry went out on the recovered id, and the slice moved with it — a
    // slice left under the dead key stops receiving its own reply.
    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ session_id: 'runtime-2' }),
      expect.anything()
    )
    expect($sessionStates.get()['runtime-1']).toBeUndefined()
    expect($sessionStates.get()['runtime-2']?.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2'])
  })
})

// --- Restore checkpoint (rewind to a past prompt and re-run it) -------------
//
// MJXHRM-370: the confirmation flow was fully implemented in the message
// component and had NO caller, so none of this was reachable.
describe('restoreToMessage', () => {
  const seedTurns = () =>
    seedActiveSession('runtime-1', {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first ask' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second ask' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second answer' }] }
      ]
    })

  it('truncates to the target prompt and re-runs it unchanged', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('u2', { text: 'second ask', userOrdinal: 1 })

    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      // `confirm_truncate` states that this submit IS a rewind; the gateway
      // refuses a bare ordinal with 4029 (see truncateSubmitParams).
      expect.objectContaining({ confirm_truncate: true, text: 'second ask', truncate_before_user_ordinal: 1 }),
      expect.anything()
    )
    // The prompt STAYS — it is being re-run, not withdrawn.
    expect($messages.get().map(m => m.id)).toEqual(['u1', 'a1', 'u2'])
    expect($busy.get()).toBe(true)
  })

  // Ordinal 0 truncates to an EMPTY transcript, which the gateway refuses unless
  // the client says it meant it — universal omitted the flag entirely, so a
  // restore to the very first prompt 422'd.
  it('confirms an empty truncate when restoring the first prompt', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('u1', { text: 'first ask', userOrdinal: 0 })

    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ truncate_before_user_ordinal: 0, confirm_empty_truncate: true }),
      expect.anything()
    )
  })

  // MJXHRM-223: the transcript hands assistant-ui a WINDOWED tail, so a caller
  // counting user turns in the rendered thread is short by every turn the window
  // dropped. Taking that number as `truncate_before_user_ordinal` rewound the
  // SESSION to an earlier turn than the one the client cut at — silent history
  // loss on exactly the long sessions the window exists for. The id resolves the
  // turn; the ordinal must follow it, never overrule it.
  it('truncates by the turn the id resolved to, not by a caller ordinal counted elsewhere', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('u2', { text: 'second ask', userOrdinal: 0 })

    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ text: 'second ask', truncate_before_user_ordinal: 1 }),
      expect.anything()
    )
    // ...and without the empty-truncate confirmation ordinal 0 would have carried.
    expect(requestGateway).not.toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ confirm_empty_truncate: true }),
      expect.anything()
    )
    expect($messages.get().map(m => m.id)).toEqual(['u1', 'a1', 'u2'])
  })

  it('falls back to the user ordinal when the id was re-keyed under us', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('an-id-from-before-a-compaction', { text: 'second ask', userOrdinal: 1 })

    // The ordinal LOCATES the turn; the truncation is still counted off the
    // resolved index, which for this path is the same number by construction.
    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ text: 'second ask', truncate_before_user_ordinal: 1 }),
      expect.anything()
    )
  })

  it('rolls the transcript back and rethrows when the rewind fails', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockRejectedValue(new Error('nope'))

    await expect(restoreToMessage('u2', { text: 'second ask', userOrdinal: 1 })).rejects.toThrow('nope')

    expect($messages.get().map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect($busy.get()).toBe(false)
  })

  it('refuses a target it cannot resolve rather than truncating something else', async () => {
    seedTurns()

    await expect(restoreToMessage('nope', { text: '', userOrdinal: null })).rejects.toThrow(/find the message/i)
    expect(requestGateway).not.toHaveBeenCalled()
  })

  // The restore affordance sits on EVERY user bubble, and a tile mounts the same
  // thread (app/chat/session-tile.tsx) — so the confirm dialog in a tile and the
  // one in the main pane look identical and address different sessions. Hydrated
  // message ids are positional (`h${index}-${role}` in lib/session-history.ts),
  // so a tile's `h2-user` RESOLVES perfectly well against the main pane's
  // transcript: resolving against the visible chat would not merely target the
  // wrong session, it would silently truncate one the user never pointed at and
  // re-run someone else's prompt into it.
  it('rewinds the session it was handed, not the one on screen', async () => {
    const hydrated = (prefix: string): ChatMessage[] => [
      { id: 'h0-user', role: 'user', parts: [{ type: 'text', text: `${prefix} first ask` }] },
      { id: 'h1-assistant', role: 'assistant', parts: [{ type: 'text', text: `${prefix} answer` }] },
      { id: 'h2-user', role: 'user', parts: [{ type: 'text', text: `${prefix} second ask` }] },
      { id: 'h3-assistant', role: 'assistant', parts: [{ type: 'text', text: `${prefix} second answer` }] }
    ]

    seedActiveSession('runtime-main', { messages: hydrated('main') })
    seedSession('runtime-tile', { messages: hydrated('tile') })
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('h2-user', { text: 'tile second ask', userOrdinal: 1 }, 'runtime-tile')

    expect(requestGateway).toHaveBeenCalledWith(
      'prompt.submit',
      expect.objectContaining({ session_id: 'runtime-tile', text: 'tile second ask' }),
      expect.anything()
    )
    expect(sessionMessages('runtime-tile').map(m => m.id)).toEqual(['h0-user', 'h1-assistant', 'h2-user'])
    // The chat on screen is untouched — no truncation, no busy, no re-run.
    expect(sessionMessages('runtime-main').map(m => m.id)).toEqual([
      'h0-user',
      'h1-assistant',
      'h2-user',
      'h3-assistant'
    ])
    expect($busy.get()).toBe(false)
  })

  // `wasBusy` decides whether the rewind interrupts first, and it has to come
  // from the target slice: read off the visible chat it answers for the wrong
  // session in both directions — interrupting a tile that was idle, or skipping
  // the interrupt its own live turn needed (the gateway then refuses the
  // truncating submit with 4009 rather than folding it into the busy path).
  it('interrupts by the target session’s own busy state, not the visible chat’s', async () => {
    seedActiveSession('runtime-main', { busy: true, messages: [] })
    seedSession('runtime-tile', {
      busy: false,
      messages: [{ id: 'h0-user', role: 'user', parts: [{ type: 'text', text: 'tile ask' }] }]
    })
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('h0-user', { text: 'tile ask', userOrdinal: 0 }, 'runtime-tile')

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual(['prompt.submit'])
  })

  // The in-flight turn record is what a reconnect reconciles against. Without
  // one, a gateway that comes back reporting idle plans `noop` and
  // `applyReconciledBusy` leaves the slice alone — so a restore whose terminal
  // frame died in the disconnect window spun `busy` forever, behind a transcript
  // it had already truncated. `sendPrompt` opens the turn at submit time for
  // exactly this reason; the rewind paths never did.
  it('opens an in-flight turn so a reconnect has something to reconcile', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockResolvedValue({})

    await restoreToMessage('u2', { text: 'second ask', userOrdinal: 1 })

    expect(getInflightTurn('runtime-1')).toMatchObject({ phase: 'submitted', prompt: 'second ask' })
  })

  it('settles that turn when the rewind fails, so nothing adopts a turn that never started', async () => {
    seedTurns()
    vi.mocked(requestGateway).mockRejectedValue(new Error('nope'))

    await expect(restoreToMessage('u2', { text: 'second ask', userOrdinal: 1 })).rejects.toThrow('nope')

    // The record has to EXIST and be settled — "no record at all" is the other
    // half of the same wedge, and `?? 'settled'` would read it as a pass.
    expect(getInflightTurn('runtime-1')).toMatchObject({ phase: 'settled', prompt: 'second ask' })
  })
})

// --- Stop -------------------------------------------------------------------
//
// MJXHRM-366: all three `session.interrupt` call sites swallowed the rejection
// with a bare `.catch(() => {})`, so after a sleep/wake Stop was a dead control
// with no error and no retry.
describe('interruptSession', () => {
  it('recovers a dead runtime and interrupts the fresh one', async () => {
    seedActiveSession('runtime-1', { busy: true })

    vi.mocked(requestGateway).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'session.resume') {
        return { session_id: 'runtime-2' }
      }

      if (params?.session_id === 'runtime-1') {
        throw new Error('session not found: runtime-1')
      }

      return {}
    })

    await expect(interruptSession('runtime-1')).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('session.interrupt', { session_id: 'runtime-2' })
    // The slice MOVED onto the recovered runtime…
    expect($sessionStates.get()['runtime-1']).toBeUndefined()
    // …and stopped being busy. This assertion used to read `busy: true`, which
    // is the bug written down as the contract: the turn the chat was busy for
    // belonged to the runtime the gateway had already dropped, so no
    // `message.complete` was ever coming to settle it and the session (or the
    // tile) sat spinning behind a Stop that had already done its job. A
    // RECOVERED interrupt is the one case where the client knows for certain the
    // old turn cannot still be running.
    expect($sessionStates.get()['runtime-2']).toMatchObject({ busy: false, streamId: null, turnStartedAt: null })
    expect(getInflightTurn('runtime-2')?.phase ?? 'settled').toBe('settled')
  })

  it('leaves a LIVE runtime busy until the gateway settles the turn it is cancelling', async () => {
    // The other half of the same rule: the gateway owns this turn, so its
    // terminal frame — not the interrupt's ack — is what ends it. Clearing busy
    // here would drop the spinner while tokens were still arriving.
    seedActiveSession('runtime-1', { busy: true })
    beginTurn('runtime-1', { prompt: 'go' })
    vi.mocked(requestGateway).mockResolvedValue({})

    await expect(interruptSession('runtime-1')).resolves.toBe(true)

    expect($sessionStates.get()['runtime-1']?.busy).toBe(true)
    expect(getInflightTurn('runtime-1')?.phase).not.toBe('settled')
  })

  it('reports failure instead of swallowing it', async () => {
    seedActiveSession('runtime-1', { busy: true })
    vi.mocked(requestGateway).mockRejectedValue(new Error('transport is gone'))

    await expect(interruptSession('runtime-1')).resolves.toBe(false)
    expect(notifyError).toHaveBeenCalled()
  })

  // The gateway answers `{"status": "interrupted"}` whether or not it had a turn
  // to stop, so its `was_running` flag is the only way to tell the two apart —
  // and the difference decides whether a terminal frame is still coming.
  it('settles the turn when the gateway reports there was nothing running', async () => {
    seedActiveSession('runtime-1', { busy: true })
    beginTurn('runtime-1', { prompt: 'go' })
    vi.mocked(requestGateway).mockResolvedValue({ status: 'interrupted', was_running: false })

    await expect(interruptSession('runtime-1')).resolves.toBe(true)

    // No `message.complete` is coming for a turn the gateway is not running: the
    // reply finished on a socket that went away. Without this the chat spun
    // forever behind a Stop that had already done its job.
    expect($sessionStates.get()['runtime-1']).toMatchObject({ busy: false, streamId: null, turnStartedAt: null })
    expect(getInflightTurn('runtime-1')?.phase).toBe('settled')
  })

  // Both surfaces seed a `hydrating:<storedId>` slice BUSY and only bind a
  // runtime id when `session.resume` returns, so opening any session shows a
  // live Stop button for the whole transcript-fetch + resume round trip — on a
  // session that may genuinely be mid-turn. This used to `return false` with no
  // RPC, no recovery and no toast: iteration 31's null-binding report, still
  // reachable after MJXHRM-358 removed the cause it named.
  it('waits for a hydrating session to bind, then interrupts the runtime it binds', async () => {
    seedActiveSession('hydrating:s1', { storedSessionId: 's1', runtimeSessionId: null, busy: true })
    vi.mocked(requestGateway).mockResolvedValue({ status: 'interrupted', was_running: true })

    const stop = interruptSession('hydrating:s1')

    // Nothing can go out yet — there is no id to address.
    await Promise.resolve()
    expect(requestGateway).not.toHaveBeenCalled()

    // The resume lands and the slice moves onto its runtime id.
    rekeySession('hydrating:s1', 'runtime-9', { runtimeSessionId: 'runtime-9', storedSessionId: 's1' })

    await expect(stop).resolves.toBe(true)
    expect(requestGateway).toHaveBeenCalledWith('session.interrupt', { session_id: 'runtime-9' })
  })

  it('reports failure when a hydrating session never binds', async () => {
    vi.useFakeTimers()

    try {
      seedActiveSession('hydrating:s2', { storedSessionId: 's2', runtimeSessionId: null, busy: true })

      const stop = interruptSession('hydrating:s2')

      await vi.advanceTimersByTimeAsync(21_000)

      await expect(stop).resolves.toBe(false)
      expect(requestGateway).not.toHaveBeenCalled()
      expect(notifyError).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // Stop before the first token, on a brand-new chat. `sendPrompt` goes busy and
  // opens the turn before `ensureSession` returns, so the whole `session.create`
  // round trip offers a Stop button on a slice with no runtime id.
  it('abandons a prompt the user stops while the session is still being created', async () => {
    seedActiveSession('draft:9', { runtimeSessionId: null, storedSessionId: null })

    let releaseCreate: (value: unknown) => void = () => {}

    vi.mocked(requestGateway).mockImplementation((method: string) => {
      if (method === 'session.create') {
        return new Promise(resolve => {
          releaseCreate = resolve
        })
      }

      return Promise.resolve({})
    })

    const sent = sendPrompt('start the long job')
    await Promise.resolve()

    expect($sessionStates.get()['draft:9']?.busy).toBe(true)
    await expect(interruptSession('draft:9')).resolves.toBe(true)

    releaseCreate({ session_id: 'runtime-created', stored_session_id: 'stored-created' })
    await sent

    // The prompt never went out — the alternative is a gateway that starts
    // streaming a reply into a chat the user has already stopped.
    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual(['session.create'])
    expect($sessionStates.get()['runtime-created']?.busy).toBe(false)
  })

  it('does nothing for an idle draft, which has nothing anywhere to stop', async () => {
    // The one honest no-op: no runtime id, no stored session, no open turn — and
    // no surface offers Stop for it, because the control follows `busy`.
    seedActiveSession('draft:1', { runtimeSessionId: null, storedSessionId: null })

    await expect(interruptSession('draft:1')).resolves.toBe(false)
    expect(requestGateway).not.toHaveBeenCalled()
  })
})

// --- Active-turn correction ("stop and correct") ---------------------------
//
// Steering is not a queue nudge: `session.redirect` cancels the model request
// in place and rebuilds the turn with the correction folded in.
describe('redirectPrompt', () => {
  const seedLiveTurn = () => {
    seedActiveSession('runtime-1', {
      runtimeSessionId: 'runtime-1',
      busy: true,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do a thing' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial…' }], pending: true }
      ]
    })
  }

  const roles = () => sessionMessages('runtime-1').map(m => m.role)
  const texts = () => sessionMessages('runtime-1').map(m => m.parts.map(p => ('text' in p ? p.text : '')).join(''))

  // A redirect aborts the model request, so its completion frame can race the
  // RPC response — the correction has to be placed before the reply it is
  // replacing, not appended once the response settles.
  it('places the correction above the live reply', async () => {
    seedLiveTurn()
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'redirected' })

    expect(await redirectPrompt('actually do this', 'runtime-1')).toBe(true)

    expect(requestGateway).toHaveBeenCalledWith('session.redirect', {
      session_id: 'runtime-1',
      text: 'actually do this'
    })
    expect(roles()).toEqual(['user', 'user', 'assistant'])
    expect(texts()[1]).toBe('actually do this')
  })

  // The turn-build window: no agent to redirect yet, so this is the NEXT
  // turn's prompt and must not sit above a reply it had no part in.
  it('moves a QUEUED correction to the tail', async () => {
    seedLiveTurn()
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'queued' })

    expect(await redirectPrompt('actually do this', 'runtime-1')).toBe(true)
    expect(roles()).toEqual(['user', 'assistant', 'user'])
  })

  // A tool was running, so the gateway deferred the correction to that tool's
  // next result instead of killing it. That is an ACCEPTANCE — falling through
  // to the rejection branch would drop the row AND hand the words back to the
  // composer's queue, delivering the same correction twice (MJXHRM-410).
  it('keeps a STEERED correction in place and does not hand it back', async () => {
    seedLiveTurn()
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'steered' })

    expect(await redirectPrompt('actually do this', 'runtime-1')).toBe(true)
    expect(roles()).toEqual(['user', 'user', 'assistant'])
    expect(texts()[1]).toBe('actually do this')
  })

  // The caller queues the words itself on false, so the optimistic row must go
  // — leaving it would show a message the agent never received.
  it('withdraws the row when the gateway rejects', async () => {
    seedLiveTurn()
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'rejected' })

    expect(await redirectPrompt('actually do this', 'runtime-1')).toBe(false)
    expect(roles()).toEqual(['user', 'assistant'])
  })

  it('withdraws the row when the RPC throws', async () => {
    seedLiveTurn()
    vi.mocked(requestGateway).mockRejectedValueOnce(new Error('socket down'))

    expect(await redirectPrompt('actually do this', 'runtime-1')).toBe(false)
    expect(roles()).toEqual(['user', 'assistant'])
  })

  it('does nothing without text or a live session', async () => {
    seedLiveTurn()

    expect(await redirectPrompt('   ', 'runtime-1')).toBe(false)
    expect(await redirectPrompt('hi', 'no-such-session')).toBe(false)
    expect(requestGateway).not.toHaveBeenCalledWith('session.redirect', expect.anything())
  })

  // The other end of `steered`: the turn finished before any tool result could
  // carry the deferred words, so the gateway requeues them as a fresh turn and
  // pushes `steer.missed`. The bubble has to stop claiming it influenced the
  // reply it is sitting above.
  describe('noteMissedSteer', () => {
    it('moves the correction to the tail and notes that it never landed', () => {
      seedActiveSession('runtime-1', {
        runtimeSessionId: 'runtime-1',
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do a thing' }] },
          { id: 'c1', role: 'user', parts: [{ type: 'text', text: 'use Postgres' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'reply that never saw it' }] }
        ]
      })

      noteMissedSteer('runtime-1', 'use Postgres')

      expect(sessionMessages('runtime-1').map(m => m.id)).toEqual(['u1', 'a1', 'c1', expect.any(String)])
      expect(roles()).toEqual(['user', 'assistant', 'user', 'system'])
      expect(texts().at(-1)).toBe('steer-missed:use Postgres')
    })

    // `/steer` and a busy submit leave no optimistic bubble to move, and the
    // note still has to appear — that is the only thing the user ever sees.
    it('still notes a miss with no matching bubble to move', () => {
      seedActiveSession('runtime-1', {
        runtimeSessionId: 'runtime-1',
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do a thing' }] }]
      })

      noteMissedSteer('runtime-1', 'typed as a slash command')

      expect(roles()).toEqual(['user', 'system'])
      expect(texts().at(-1)).toBe('steer-missed:typed as a slash command')
    })

    it('ignores an empty text or an unknown session', () => {
      seedActiveSession('runtime-1', { runtimeSessionId: 'runtime-1', messages: [] })

      noteMissedSteer('runtime-1', '   ')

      expect(sessionMessages('runtime-1')).toEqual([])
    })
  })

  // The record is what a reconnect reconciles against, and what the warm-resume
  // projection rebuilds the extra user bubble from.
  it('records the correction on the in-flight turn', async () => {
    seedLiveTurn()
    beginTurn('runtime-1', { prompt: 'do a thing' })
    vi.mocked(requestGateway).mockResolvedValueOnce({ status: 'redirected' })

    await redirectPrompt('actually do this', 'runtime-1')

    expect(getInflightTurn('runtime-1')).toMatchObject({
      prompt: 'do a thing',
      corrections: ['actually do this']
    })
  })
})

// --- Stale-runtime recovery ------------------------------------------------
//
// The gateway drops a session's in-memory runtime on sleep/wake, a restart, or a
// long idle. The STORED session survives; the runtime id the client holds does
/**
 * Interrupted-submit flagging (MJXHRM-389).
 *
 * Universal cut the audio on a barge-in and told the model nothing, so the reply
 * the user never heard the end of came back referenced as though it had landed
 * in full. The gateway already accepts the flag (`mark_speech_interrupted`); the
 * client just never sent it.
 *
 * The negative case matters as much as the positive: `interrupted` must be
 * ABSENT — not `false` — on an ordinary submit, so a backend that predates the
 * flag sees the params it always did.
 */
describe('interrupted-submit flagging', () => {
  const speaking = async () => {
    const { $voicePlayback } = await import('@/store/voice-playback')
    $voicePlayback.set({ source: 'read-aloud', messageId: 'a1', status: 'speaking' })
  }

  const submitParams = () =>
    vi.mocked(requestGateway).mock.calls.find(call => call[0] === 'prompt.submit')?.[1] as Record<string, unknown>

  beforeEach(async () => {
    const { takeVoicePlaybackInterrupted } = await import('@/lib/voice-playback')
    const { resetVoicePlayback } = await import('@/store/voice-playback')
    takeVoicePlaybackInterrupted()
    resetVoicePlayback()
  })

  it('flags a prompt typed over a reply being read aloud', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    await speaking()

    await sendPrompt('actually, never mind that')

    expect(submitParams()).toMatchObject({ text: 'actually, never mind that', interrupted: true })
  })

  it('omits the flag entirely when nothing was playing', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })

    await sendPrompt('a perfectly ordinary question')

    expect(submitParams()).not.toHaveProperty('interrupted')
  })

  it('carries a latch set by the voice loop, which cut playback long before this', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    const { markVoicePlaybackInterrupted } = await import('@/lib/voice-playback')

    // Exactly what a Rust `speechStart` barge-in leaves behind: the latch set,
    // and `$voicePlayback` already back to idle.
    markVoicePlaybackInterrupted()

    await sendPrompt('wait, stop')

    expect(submitParams()).toMatchObject({ interrupted: true })
  })

  it('flags only the FIRST submit after an interruption', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    await speaking()

    await sendPrompt('first')
    vi.mocked(requestGateway).mockClear()
    updateSession('runtime-1', state => ({ ...state, busy: false }))
    await sendPrompt('second')

    expect(submitParams()).not.toHaveProperty('interrupted')
  })
})

// not, and every session-scoped RPC then answers "session not found". One shared
// resolver rebinds and retries once (store/session-recovery.ts).
describe('stale-runtime recovery', () => {
  /** A gateway that has forgotten the live runtime and resumes it as `freshId`. */
  const forgetsTheRuntime = (freshId: string) =>
    vi
      .mocked(requestGateway)
      .mockRejectedValueOnce(new Error('session not found'))
      .mockResolvedValueOnce({ session_id: freshId })
      .mockResolvedValueOnce({})

  it('rebinds a dropped runtime and resubmits the prompt', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    forgetsTheRuntime('runtime-2')

    await sendPrompt('are you still there')

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual([
      'prompt.submit',
      'session.resume',
      'prompt.submit'
    ])
    // The resume names the STORED id — the runtime one is precisely what the
    // gateway has forgotten — and the retry goes out on the id it hands back.
    expect(vi.mocked(requestGateway).mock.calls[1][1]).toMatchObject({ session_id: 'stored-1' })
    expect(vi.mocked(requestGateway).mock.calls[2][1]).toMatchObject({ session_id: 'runtime-2' })
    // Recovered, so the user sees a sent message rather than an error line.
    expect($statusLine.get()).toBe('')
    expect($busy.get()).toBe(true)
  })

  // The event router addresses slices by the session id the gateway stamps on
  // each frame, so a slice left under the DEAD key would never see the reply to
  // the prompt it just recovered — it would sit busy forever.
  it('moves the slice onto the fresh runtime id', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    forgetsTheRuntime('runtime-2')

    await sendPrompt('are you still there')

    expect($sessionStates.get()['runtime-1']).toBeUndefined()
    expect($sessionId.get()).toBe('runtime-2')
    expect(sessionMessages('runtime-2').map(messageText)).toContain('are you still there')
    // The turn opened before the recovery has to travel with it, or a reconnect
    // has nothing to reconcile the resubmitted turn against.
    expect(getInflightTurn('runtime-2')).toMatchObject({ prompt: 'are you still there' })
  })

  // Steering failed the same way, and QUIETLY: a false sends the words to the
  // composer's local queue, so a dropped runtime looked like "steering just
  // doesn't work after sleep" rather than an error.
  it('rebinds a dropped runtime and re-sends the correction', async () => {
    seedActiveSession('runtime-1', {
      storedSessionId: 'stored-1',
      busy: true,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'do a thing' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'partial…' }], pending: true }
      ]
    })
    vi.mocked(requestGateway)
      .mockRejectedValueOnce(new Error('session not found'))
      .mockResolvedValueOnce({ session_id: 'runtime-2' })
      // A resumed runtime has no live turn left to fold into, so the correction
      // becomes the next turn's prompt — and belongs at the tail.
      .mockResolvedValueOnce({ status: 'queued' })

    expect(await redirectPrompt('actually do this', 'runtime-1')).toBe(true)

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual([
      'session.redirect',
      'session.resume',
      'session.redirect'
    ])
    expect(sessionMessages('runtime-2').map(messageText)).toEqual(['do a thing', 'partial…', 'actually do this'])
  })

  // MJXHRM-308, one layer above the resolver that fixed it: the default
  // `onRecovered` REKEYS the slice, and store/prompts.ts carries the approval
  // request onto the new key with it. A responder that clears the key it
  // captured before the await therefore clears nothing — the agent is unblocked
  // while the bar stays on screen forever, the same no-error/no-retry shape as
  // the tile hang this ticket is named for.
  it('clears the approval bar on the key the recovery moved the slice to', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    handleGatewayEvent(ev('approval.request', { command: 'rm -rf /' }))
    forgetsTheRuntime('runtime-2')

    await respondApproval('once')

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual([
      'approval.respond',
      'session.resume',
      'approval.respond'
    ])
    expect(vi.mocked(requestGateway).mock.calls[2][1]).toMatchObject({ session_id: 'runtime-2' })
    // `$approval` reads the ACTIVE key, which the rekey moved too — so this is
    // the bar the user is looking at, not a stale projection.
    expect($approval.get()).toBeNull()
    expect(sessionApprovalRequest('runtime-2').get()).toBeNull()
  })

  // A draft has no stored session to resume, so there is nothing to recover to
  // and the original error stands.
  it('surfaces the error when the session cannot be resumed', async () => {
    seedActiveSession('runtime-1', { storedSessionId: 'stored-1' })
    vi.mocked(requestGateway)
      .mockRejectedValueOnce(new Error('session not found'))
      .mockRejectedValueOnce(new Error('no such stored session'))

    await sendPrompt('are you still there')

    expect($statusLine.get()).toBe('session not found')
    expect($busy.get()).toBe(false)
  })
})
