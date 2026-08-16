/**
 * The gateway hand-parses `params` and answers a bare 4000-series error when a
 * key is spelled wrong, so these tests pin the FRAME each helper puts on the
 * wire — key for key — against the handlers in tui_gateway/.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))

import { GatewayRpcError } from '@/gateway/rpc-error'
import { requestGateway } from '@/store/gateway'

import {
  feedWakeAudio,
  isMissingRpcMethod,
  moveSessionWorkspace,
  reactToMessage,
  respondPreviewRead,
  respondWindowRead,
  steerSubagent,
  WAKE_FEED_SAMPLE_RATE
} from './gateway-rpc'

const rpc = vi.mocked(requestGateway)

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({})
})

/** The params of the single call made. */
const sentParams = () => rpc.mock.calls[0]?.[1]

describe('message.react', () => {
  it('addresses a persisted row by row_id and defaults the author to the user', async () => {
    await reactToMessage({ sessionId: 's1', target: { row_id: 42 }, emoji: '👍' })

    expect(rpc).toHaveBeenCalledWith('message.react', {
      session_id: 's1',
      row_id: 42,
      emoji: '👍',
      author: 'user'
    })
  })

  it('addresses a LIVE message by newest_role instead, since it has no row id yet', async () => {
    await reactToMessage({ sessionId: 's1', target: { newest_role: 'assistant' }, emoji: '❤️', author: 'agent' })

    expect(sentParams()).toEqual({
      session_id: 's1',
      newest_role: 'assistant',
      emoji: '❤️',
      author: 'agent'
    })
  })

  it('sends a literal null emoji to clear — not an omitted key, which the backend reads as "no change"', async () => {
    await reactToMessage({ sessionId: 's1', target: { row_id: 7 }, emoji: null })

    expect(sentParams()).toMatchObject({ emoji: null })
    expect(Object.keys(sentParams() as object)).toContain('emoji')
  })

  it('returns the row the backend resolved plus its authoritative reaction list', async () => {
    rpc.mockResolvedValue({ row_id: 9, reactions: [{ emoji: '👍', author: 'user', at: 1 }] })

    await expect(reactToMessage({ sessionId: 's1', target: { newest_role: 'user' }, emoji: '👍' })).resolves.toEqual({
      row_id: 9,
      reactions: [{ emoji: '👍', author: 'user', at: 1 }]
    })
  })
})

describe('preview/window read respond', () => {
  it('answers a preview read with request_id + text', async () => {
    rpc.mockResolvedValue({ status: 'ok' })

    await expect(respondPreviewRead('req-1', '{"text":"hi"}')).resolves.toEqual({ status: 'ok' })
    expect(rpc).toHaveBeenCalledWith('preview.read.respond', { request_id: 'req-1', text: '{"text":"hi"}' })
  })

  it('answers a window read on its own method', async () => {
    await respondWindowRead('req-2', '')

    expect(rpc).toHaveBeenCalledWith('window.read.respond', { request_id: 'req-2', text: '' })
  })

  it('treats an expired answer as a normal result, not a rejection', async () => {
    rpc.mockResolvedValue({ status: 'expired' })

    await expect(respondWindowRead('req-3', '{}')).resolves.toEqual({ status: 'expired' })
  })
})

describe('session.workspace.move', () => {
  it('sends the STORED session_key and cwd, omitting profile when unset', async () => {
    await moveSessionWorkspace({ sessionKey: 'sess-abc', cwd: '/repo/app' })

    expect(sentParams()).toEqual({ cwd: '/repo/app', session_key: 'sess-abc' })
  })

  it('threads a profile through when one is given', async () => {
    await moveSessionWorkspace({ sessionKey: 'sess-abc', cwd: '/repo/app', profile: 'work' })

    expect(sentParams()).toEqual({ cwd: '/repo/app', session_key: 'sess-abc', profile: 'work' })
  })

  it('returns the resolved cwd plus the REPLACED git identity', async () => {
    rpc.mockResolvedValue({ cwd: '/repo/app', branch: 'main', git_repo_root: '/repo' })

    await expect(moveSessionWorkspace({ sessionKey: 's', cwd: '~/repo/app' })).resolves.toEqual({
      cwd: '/repo/app',
      branch: 'main',
      git_repo_root: '/repo'
    })
  })
})

describe('subagent.steer', () => {
  it('sends the invoking session alongside the child id and text', async () => {
    rpc.mockResolvedValue({ status: 'queued', subagent_id: 'sub-1', text: 'focus on pricing' })

    await steerSubagent({ sessionId: 's1', subagentId: 'sub-1', text: 'focus on pricing' })

    expect(rpc).toHaveBeenCalledWith('subagent.steer', {
      session_id: 's1',
      subagent_id: 'sub-1',
      text: 'focus on pricing'
    })
  })

  it('surfaces a refusal as a RESOLVED rejected status — the backend never errors for it', async () => {
    rpc.mockResolvedValue({ status: 'rejected', subagent_id: 'sub-1', text: 'too late' })

    await expect(steerSubagent({ sessionId: 's1', subagentId: 'sub-1', text: 'too late' })).resolves.toMatchObject({
      status: 'rejected'
    })
  })
})

describe('wake.feed', () => {
  it('sends base64 pcm at 16 kHz with a short timeout so a stalled socket cannot pile up frames', async () => {
    rpc.mockResolvedValue({ fed: true, reason: null })

    await feedWakeAudio('AAECAw==')

    expect(rpc).toHaveBeenCalledWith(
      'wake.feed',
      { pcm: 'AAECAw==', sample_rate: WAKE_FEED_SAMPLE_RATE },
      expect.any(Number)
    )
    expect(rpc.mock.calls[0]?.[2]).toBeLessThan(120_000)
  })

  it('reports a frame the detector refused because another transport owns it', async () => {
    rpc.mockResolvedValue({ fed: false, reason: 'not_owner' })

    await expect(feedWakeAudio('AAA=')).resolves.toEqual({ fed: false, reason: 'not_owner' })
  })
})

describe('isMissingRpcMethod', () => {
  it('recognises every spelling a gateway uses for an unknown method', () => {
    for (const message of ['Method not found', 'rpc error -32601', 'unknown method: wake.feed', 'no such method']) {
      expect(isMissingRpcMethod(new Error(message))).toBe(true)
    }
  })

  it('does not swallow a real failure', () => {
    expect(isMissingRpcMethod(new Error('session busy'))).toBe(false)
    expect(isMissingRpcMethod('gateway not connected')).toBe(false)
  })

  it('believes the -32601 code even when the prose is one we would not recognise', () => {
    // The gateway says "unknown method: X" today. It is the only emitter of
    // -32601 (tui_gateway/server.py handle_request), but the prose is not a
    // contract and a proxy in front of it never promised our four spellings.
    expect(isMissingRpcMethod(new GatewayRpcError('the requested procedure does not exist', -32601))).toBe(true)
  })

  it('does not read a nested -32601 in a real failure as an old backend', () => {
    // A handler that fails because something IT called answered -32601 (an MCP
    // server behind a tool does exactly this) comes back under the handler's
    // own code with the nested error quoted in the message. Prose alone read
    // that as "this backend predates the method" and latched surfaces —
    // projects, the pet gallery — into a degraded mode for the whole session.
    const nested = new GatewayRpcError('tool failed: McpError(-32601 Method not found)', 5061)

    expect(isMissingRpcMethod(nested)).toBe(false)
  })

  it('still reads the message when the rejection carries no code', () => {
    // Not every rejection comes off the wire: a locally constructed Error, or a
    // frame with no `code` at all.
    expect(isMissingRpcMethod(new GatewayRpcError('unknown method: pet.gallery', null))).toBe(true)
    expect(isMissingRpcMethod(new GatewayRpcError('session busy', null))).toBe(false)
  })
})
