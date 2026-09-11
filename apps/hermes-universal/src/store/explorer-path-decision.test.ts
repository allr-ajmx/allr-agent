/**
 * The decision half of a folder pick, with no webview, no socket and no atoms
 * (rule 35) — which is the whole reason it is a separate module.
 *
 * The invariant worth pinning hardest is the negative one: a mid-turn session
 * must produce a plan that changes NOTHING. The bug this change exists to fix
 * was a view that moved while the cwd did not, and "block the RPC but re-root
 * the tree anyway" would be that same bug wearing a warning label.
 */

import { describe, expect, it } from 'vitest'

import { GatewayRpcError } from '@/gateway/rpc-error'

import {
  explorerPathFailure,
  type FocusedSessionFacts,
  isSessionMidTurn,
  planExplorerPath
} from './explorer-path-decision'

const IDLE: FocusedSessionFacts = {
  awaitingResponse: false,
  busy: false,
  needsInput: false,
  runtimeSessionId: 'runtime-1'
}

const NO_SESSION: FocusedSessionFacts = { ...IDLE, runtimeSessionId: null }

describe('planExplorerPath', () => {
  it('asks when a live, idle session is focused', () => {
    expect(planExplorerPath('/srv/work', IDLE)).toEqual({
      kind: 'prompt',
      path: '/srv/work',
      runtimeSessionId: 'runtime-1'
    })
  })

  it('carries the RUNTIME id, which is the only id `session.cwd.set` accepts', () => {
    // Rule 17: session key ≠ runtime id ≠ stored id. The gateway resolves this
    // method through a straight `_sessions[session_id]` lookup, so a stored key
    // comes back as a bare `4001 session not found` — a silent failure the
    // plan's shape is what prevents.
    const plan = planExplorerPath('/srv/work', { ...IDLE, runtimeSessionId: 'sess_abc123' })

    expect(plan).toMatchObject({ kind: 'prompt', runtimeSessionId: 'sess_abc123' })
  })

  it('trims the path before anything else looks at it', () => {
    expect(planExplorerPath('  /srv/work  ', IDLE)).toMatchObject({ path: '/srv/work' })
    expect(planExplorerPath('  /srv/work  ', NO_SESSION)).toEqual({ kind: 'detached', path: '/srv/work' })
  })

  it('ignores a blank path instead of rooting anything at nothing', () => {
    // The Home button reads `home` off `/api/fs/default-cwd`, an ADDITIVE field
    // an older gateway omits entirely.
    expect(planExplorerPath('', IDLE)).toEqual({ kind: 'ignore' })
    expect(planExplorerPath('   ', NO_SESSION)).toEqual({ kind: 'ignore' })
  })

  it('goes straight to the workspace when nothing live is focused', () => {
    // The Home bucket, a detached chat, an unsent draft: no session's work is at
    // stake, so there is no question to ask.
    expect(planExplorerPath('/srv/work', NO_SESSION)).toEqual({ kind: 'detached', path: '/srv/work' })
  })

  it('treats a whitespace-only runtime id as no session at all', () => {
    expect(planExplorerPath('/srv/work', { ...IDLE, runtimeSessionId: '  ' })).toEqual({
      kind: 'detached',
      path: '/srv/work'
    })
  })

  it('blocks mid-turn, and blocks it in every one of the three ways', () => {
    for (const flag of ['awaitingResponse', 'busy', 'needsInput'] as const) {
      expect(planExplorerPath('/srv/work', { ...IDLE, [flag]: true })).toEqual({ kind: 'blocked' })
    }
  })

  it('blocks BEFORE it asks whether there is a runtime id to move', () => {
    // The ordering that matters. A session that is busy while still on a
    // placeholder key has no runtime id yet — answering `detached` there would
    // re-root the tree under a running agent, which is exactly the desync being
    // closed. Blocked wins.
    expect(planExplorerPath('/srv/work', { ...NO_SESSION, busy: true })).toEqual({ kind: 'blocked' })
  })

  it('still ignores a blank path even mid-turn', () => {
    // Nothing was asked for, so there is nothing to refuse and no notification
    // to show for it.
    expect(planExplorerPath('', { ...IDLE, busy: true })).toEqual({ kind: 'ignore' })
  })
})

describe('isSessionMidTurn', () => {
  it('counts a blocking prompt as mid-turn', () => {
    // `needsInput` means the agent is parked in the backend's `_block` — the
    // gateway's own gate is `session["running"]`, which is still true there, so
    // treating it as idle would earn a `4009` instead of a readable refusal.
    expect(isSessionMidTurn({ ...IDLE, needsInput: true })).toBe(true)
    expect(isSessionMidTurn(IDLE)).toBe(false)
  })
})

describe('explorerPathFailure', () => {
  it('maps the gateway 4009 refusal to "busy" rather than a generic failure', () => {
    expect(explorerPathFailure(new GatewayRpcError('session busy', 4009))).toBe('busy')
  })

  it('calls everything else generic — including a rejection with no code', () => {
    expect(explorerPathFailure(new GatewayRpcError('cwd required', 4016))).toBe('generic')
    expect(explorerPathFailure(new Error('socket closed'))).toBe('generic')
    expect(explorerPathFailure(undefined)).toBe('generic')
  })
})
