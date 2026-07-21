import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return { requestGateway: vi.fn().mockResolvedValue({}), $gatewayState: atom('idle') }
})
import { requestGateway } from '@/store/gateway'

import {
  $approval,
  $clarify,
  $currentCwd,
  $messages,
  $secret,
  $sessionId,
  $sudo,
  handleGatewayEvent,
  resetChat,
  respondClarify,
  respondSudo
} from './chat'

const ev = (type: string, payload: Record<string, unknown>): GatewayEvent =>
  ({ type, payload }) as unknown as GatewayEvent

beforeEach(() => resetChat())

describe('chat reducer (parts model)', () => {
  it('builds text + reasoning + tool parts from a stream', () => {
    handleGatewayEvent(ev('message.start', {}))
    handleGatewayEvent(ev('message.delta', { text: 'Hel' }))
    handleGatewayEvent(ev('message.delta', { text: 'lo' }))
    handleGatewayEvent(ev('reasoning.delta', { text: 'hmm' }))
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 't1', args: { q: 'x' } }))
    handleGatewayEvent(ev('tool.complete', { tool_id: 't1', result: 'done' }))
    handleGatewayEvent(ev('message.complete', {}))

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
    handleGatewayEvent(
      ev('approval.request', { command: 'rm -rf /', choices: ['once', 'deny'], smart_denied: true })
    )
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

  it('respondSudo posts sudo.respond with the request_id + password and clears the atom', async () => {
    handleGatewayEvent(ev('sudo.request', { request_id: 's9', prompt: 'pw' }))
    await respondSudo('hunter2')
    expect(requestGateway).toHaveBeenCalledWith('sudo.respond', { request_id: 's9', password: 'hunter2' })
    expect($sudo.get()).toBeNull()
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

  it('ignores tool events belonging to another session', () => {
    $sessionId.set('runtime-1')
    handleGatewayEvent(sessionEv('message.start', 'runtime-1'))
    handleGatewayEvent(sessionEv('tool.start', 'other-runtime', { name: 'grep', tool_id: 'x1' }))

    expect($messages.get()[0].parts.filter(p => p.type === 'tool-call')).toHaveLength(0)
  })

  it('still reduces events for the active session', () => {
    $sessionId.set('runtime-1')
    handleGatewayEvent(sessionEv('message.start', 'runtime-1'))
    handleGatewayEvent(sessionEv('tool.start', 'runtime-1', { name: 'grep', tool_id: 'x1' }))

    expect($messages.get()[0].parts.filter(p => p.type === 'tool-call')).toHaveLength(1)
  })

  // When the gateway does NOT stamp ids, the whole stream pins to whichever
  // session was active at message.start, so a mid-turn chat switch can't drag
  // the old turn's tool events into the newly opened transcript.
  it('pins unscoped stream events to the session that started the turn', () => {
    $sessionId.set('runtime-1')
    handleGatewayEvent(ev('message.start', {}))
    // The user switches chats mid-turn; the old turn's tail keeps arriving.
    $sessionId.set('runtime-2')
    $messages.set([])
    handleGatewayEvent(ev('tool.start', { name: 'grep', tool_id: 'x1' }))

    expect($messages.get().some(m => m.parts.some(p => p.type === 'tool-call'))).toBe(false)
  })
})

describe('session.info cwd tracking', () => {
  it('follows the active session relocating itself', () => {
    $sessionId.set('runtime-1')
    handleGatewayEvent(ev('session.info', { session_id: 'runtime-1', cwd: '/home/me/worktree-b' }))
    expect($currentCwd.get()).toBe('/home/me/worktree-b')
  })

  it('ignores info for a background session', () => {
    $sessionId.set('runtime-1')
    $currentCwd.set('/home/me/project-a')
    handleGatewayEvent(ev('session.info', { session_id: 'other-runtime', cwd: '/home/me/somewhere-else' }))
    expect($currentCwd.get()).toBe('/home/me/project-a')
  })

  it('applies a global broadcast only when no chat is open', () => {
    $sessionId.set(null)
    handleGatewayEvent(ev('session.info', { cwd: '/home/me/default' }))
    expect($currentCwd.get()).toBe('/home/me/default')

    $sessionId.set('runtime-1')
    handleGatewayEvent(ev('session.info', { cwd: '/home/me/other-default' }))
    expect($currentCwd.get()).toBe('/home/me/default')
  })

  it('treats an empty cwd as unknown rather than a detach', () => {
    $sessionId.set('runtime-1')
    $currentCwd.set('/home/me/project-a')
    handleGatewayEvent(ev('session.info', { session_id: 'runtime-1', cwd: '' }))
    expect($currentCwd.get()).toBe('/home/me/project-a')
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
