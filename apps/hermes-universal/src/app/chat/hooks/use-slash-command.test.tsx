import { render } from '@testing-library/react'
import { atom, computed } from 'nanostores'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('open'),
    getGatewayClient: () => null
  }
})

import { type SessionView, SessionViewProvider } from '@/app/chat/session-view'
import type * as ChatStoreModule from '@/store/chat'
import { $messages, $sessionId, resetChat, sendPrompt } from '@/store/chat'
import { $compactingSessions, sessionCompacting } from '@/store/compaction'
import { $composerDraft } from '@/store/composer'
import { requestGateway } from '@/store/gateway'
import { $modelPickerOpen } from '@/store/model'
import { $sessions } from '@/store/session'
import { $sessionStates, emptySessionState, publishSessionState, updateSession } from '@/store/session-state-types'
import { resetSessionStates, seedActiveSession } from '@/test-sessions'
import { ThemeProvider } from '@/themes/context'

import { useSlashCommand } from './use-slash-command'

vi.mock('@/store/chat', async importOriginal => {
  const actual = await importOriginal<typeof ChatStoreModule>()

  return {
    ...actual,
    // The dispatcher only ever needs an id back; don't hit session.create.
    ensureSession: vi.fn(async () => ({ id: 'sess-1', storedId: 'sess-1' })),
    sendPrompt: vi.fn(async () => {})
  }
})

let run: (command: string, options?: { recordInput?: boolean }) => Promise<void>

function Harness() {
  run = useSlashCommand()

  return null
}

function mount() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    </MemoryRouter>
  )
}

/** Text of every system line currently in the transcript. */
const systemLines = () =>
  $messages
    .get()
    .filter(m => m.role === 'system')
    .map(m => m.parts.map(p => ('text' in p ? p.text : '')).join(''))

beforeEach(() => {
  resetChat()
  seedActiveSession('sess-1')
  $composerDraft.set('')
  $modelPickerOpen.set(false)
  vi.mocked(requestGateway).mockReset()
  vi.mocked(sendPrompt).mockClear()
  mount()
})

afterEach(() => {
  $sessions.set([])
  updateSession('sess-1', s => ({ ...s, busy: false }))
})

describe('useSlashCommand', () => {
  it('renders slash.exec output as a slash: system line', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ output: 'all good' } as never)

    await run('/status')

    expect(requestGateway).toHaveBeenCalledWith('slash.exec', { session_id: 'sess-1', command: 'status' })
    expect(systemLines()).toEqual(['slash:/status\nall good'])
  })

  it('prefixes a warning ahead of the output', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ output: 'body', warning: 'careful' } as never)

    await run('/status')

    expect(systemLines()).toEqual(['slash:/status\nwarning: careful\nbody'])
  })

  it('follows an alias directive to the aliased command', async () => {
    vi.mocked(requestGateway)
      .mockResolvedValueOnce({ type: 'alias', target: 'status' } as never)
      .mockResolvedValueOnce({ output: 'aliased output' } as never)

    await run('/tasks x')

    expect(vi.mocked(requestGateway).mock.calls[1]).toEqual([
      'slash.exec',
      { session_id: 'sess-1', command: 'status x' }
    ])
    // The alias hop re-runs with recordInput=false, so the output prints bare
    // rather than being labelled with the aliased-to command (desktop parity).
    expect(systemLines()).toEqual(['aliased output'])
  })

  it('submits a send directive as a prompt', async () => {
    vi.mocked(requestGateway).mockResolvedValue({
      type: 'send',
      message: 'do the thing',
      notice: '⊙ Goal set'
    } as never)

    await run('/goal ship it')

    expect(systemLines()).toEqual(['slash:/goal ship it\n⊙ Goal set'])
    expect(sendPrompt).toHaveBeenCalledWith('do the thing')
  })

  it('refuses a send directive while the session is busy', async () => {
    updateSession('sess-1', s => ({ ...s, busy: true }))
    vi.mocked(requestGateway).mockResolvedValue({ type: 'send', message: 'do the thing' } as never)

    await run('/goal ship it')

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(systemLines().at(-1)).toContain('session busy')
  })

  it('drops a prefill directive into the composer instead of sending', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ type: 'prefill', message: 'restored text' } as never)

    await run('/undo')

    expect($composerDraft.get()).toBe('restored text')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('runs a client action (/new) without touching the gateway', async () => {
    await run('/new')

    expect(requestGateway).not.toHaveBeenCalled()
    expect($sessionId.get()).toBeNull()
  })

  it('opens the model picker for a bare /model but execs /model <name>', async () => {
    await run('/model')
    expect($modelPickerOpen.get()).toBe(true)
    expect(requestGateway).not.toHaveBeenCalled()

    vi.mocked(requestGateway).mockResolvedValue({ output: 'switched' } as never)
    await run('/model opus')
    expect(requestGateway).toHaveBeenCalledWith('slash.exec', { session_id: 'sess-1', command: 'model opus' })
  })

  it('forks the thread on /branch instead of asking the backend', async () => {
    updateSession('sess-1', s => ({
      ...s,
      messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }]
    }))
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await run('/branch')

    expect(requestGateway).toHaveBeenCalledWith('session.create', expect.objectContaining({ cols: 96 }))
    expect(vi.mocked(requestGateway).mock.calls[0][1]).toMatchObject({
      messages: [{ content: 'answer', role: 'assistant' }]
    })
    expect($sessionId.get()).toBe('runtime-2')
  })

  it('runs the handoff RPC chain for /handoff <platform>', async () => {
    vi.mocked(requestGateway)
      .mockResolvedValueOnce({ queued: true } as never)
      .mockResolvedValueOnce({ state: 'completed' } as never)

    await run('/handoff telegram')

    expect(vi.mocked(requestGateway).mock.calls[0]).toEqual([
      'handoff.request',
      { platform: 'telegram', session_id: 'sess-1' }
    ])
    expect(systemLines().at(-1)).toContain('telegram')
  })

  it('does not send a bare /handoff to the backend', async () => {
    await run('/handoff')

    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('explains an unavailable command instead of executing it', async () => {
    await run('/clear')

    expect(requestGateway).not.toHaveBeenCalled()
    expect(systemLines()[0]).toContain('only available in the terminal interface')
  })

  it('restores the payload of a degenerate slash and reports it', async () => {
    await run('/ some text')

    expect($composerDraft.get()).toBe('/ some text')
    expect(systemLines()).toEqual(['empty slash command'])
  })
  // MJXHRM-308: the recovery resolver's default `onRecovered` REKEYS the slice
  // onto the recovered runtime id (PR #117 changed it from a no-op alias), so
  // `/compress` — which captures the session key before its minutes-long await
  // — was writing the summarized transcript to a key nothing reads any more.
  // `updateSession` creates on demand, so that write RESURRECTED an empty ghost
  // slice under the dead key and the real session kept showing the very bubbles
  // the compaction had just removed.
  describe('/compress after the gateway dropped the runtime', () => {
    const forgetsTheRuntime = () =>
      vi
        .mocked(requestGateway)
        .mockRejectedValueOnce(new Error('session not found'))
        .mockResolvedValueOnce({ session_id: 'compress-2' } as never)
        .mockResolvedValueOnce({
          messages: [{ role: 'user', content: 'the summary' }],
          summary: { headline: 'compacted' }
        } as never)

    it('lands the compressed transcript on the key the recovery moved the slice to', async () => {
      seedActiveSession('sess-1', { storedSessionId: 'stored-compress' })
      forgetsTheRuntime()

      await run('/compress')

      expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual([
        'session.compress',
        'session.resume',
        'session.compress'
      ])
      // The resume names the slice's OWN stored id, not the sidebar selection —
      // the two differ for anything resumed, and this is what it resumes FROM.
      expect(vi.mocked(requestGateway).mock.calls[1][1]).toMatchObject({ session_id: 'stored-compress' })

      const states = $sessionStates.get()

      // No ghost slice resurrected under the dead key, and the POST-compress
      // history landed on the live one (this command's own system line follows).
      expect(states['sess-1']).toBeUndefined()
      expect(states['compress-2']?.messages[0]).toMatchObject({
        role: 'user',
        parts: [{ type: 'text', text: 'the summary' }]
      })
      // And the compacting gate is released on the key that actually holds it,
      // or every later correction queues instead of steering, forever.
      expect(sessionCompacting('compress-2').get()).toBe(false)
      expect($compactingSessions.get()).toEqual({})
    })
  })

  // MJXHRM-367: `/compress` was the only exec path through this hook that
  // recovered. `slash.exec` is the door `/undo` and `/retry` come through, and
  // both rewrite session history destructively — so a runtime the gateway had
  // dropped over a sleep/wake turned them into a bare "session not found" line.
  it('resumes a dropped runtime and re-runs the slash command on the fresh id', async () => {
    seedActiveSession('sess-1', { storedSessionId: 'stored-slash' })
    vi.mocked(requestGateway)
      .mockRejectedValueOnce(new Error('session not found'))
      .mockResolvedValueOnce({ session_id: 'slash-2' } as never)
      .mockResolvedValueOnce({ output: 'undone' } as never)

    await run('/undo')

    expect(vi.mocked(requestGateway).mock.calls.map(call => call[0])).toEqual([
      'slash.exec',
      'session.resume',
      'slash.exec'
    ])
    expect(vi.mocked(requestGateway).mock.calls[1][1]).toMatchObject({ session_id: 'stored-slash' })
    expect(vi.mocked(requestGateway).mock.calls[2][1]).toMatchObject({ command: 'undo', session_id: 'slash-2' })
  })
})

/**
 * MJXHRM-357. The dispatcher used to resolve its target as the ACTIVE session,
 * full stop — true while universal had one thread, false from the moment tiles
 * landed. A tile's composer mounts this hook under the TILE's session view, so
 * `/compress` typed into a tile ran `session.compress` against the main pane's
 * session and replaced the main pane's transcript with the summary.
 */
describe('a slash command typed in a tile', () => {
  function TileHarness() {
    run = useSlashCommand()

    return null
  }

  const tileView = (key: string): SessionView => ({
    kind: 'tile',
    $runtimeId: atom<string | null>(key),
    $storedId: atom<string | null>(null),
    $messages: computed($sessionStates, states => states[key]?.messages ?? []),
    $busy: computed($sessionStates, states => Boolean(states[key]?.busy)),
    $awaitingResponse: atom(false),
    $messagesEmpty: atom(false),
    $lastVisibleIsUser: atom(false),
    $statusLine: atom(''),
    $cwd: atom(''),
    $model: atom(''),
    $provider: atom(''),
    $fast: atom(false),
    $reasoningEffort: atom('')
  })

  beforeEach(() => {
    // Only these two slices: `resetChat` leaves a draft behind per test, and the
    // LRU cap would otherwise evict the very sessions under test.
    resetSessionStates()
    seedActiveSession('sess-1')
    // A second, background session — the tile's — beside the active one.
    publishSessionState('tile-1', { ...emptySessionState('stored-tile'), runtimeSessionId: 'tile-1' })

    render(
      <MemoryRouter>
        <ThemeProvider>
          <SessionViewProvider value={tileView('tile-1')}>
            <TileHarness />
          </SessionViewProvider>
        </ThemeProvider>
      </MemoryRouter>
    )
  })

  it('compresses the tile session, not the chat in the foreground', async () => {
    vi.mocked(requestGateway).mockResolvedValue({
      messages: [{ role: 'user', content: 'the summary' }],
      summary: { headline: 'compacted' }
    } as never)

    await run('/compress')

    expect(vi.mocked(requestGateway).mock.calls[0][0]).toBe('session.compress')
    expect(vi.mocked(requestGateway).mock.calls[0][1]).toMatchObject({ session_id: 'tile-1' })

    const states = $sessionStates.get()

    // The summarized transcript AND the command's own system line land on the
    // tile; the foreground chat is untouched.
    expect(states['tile-1'].messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'the summary' }] })
    expect(states['tile-1'].messages.some(m => m.role === 'system')).toBe(true)
    expect(states['sess-1'].messages).toEqual([])
  })

  // MJXHRM-388: the same defect as `/compress` above, one command over.
  // `/branch` read the primary atoms, so branching from a tile forked the MAIN
  // pane's conversation and left the tile it was typed in untouched.
  it('branches the tile session, not the chat in the foreground', async () => {
    const said = (text: string) => [{ id: 'm1', role: 'assistant' as const, parts: [{ type: 'text' as const, text }] }]

    updateSession('sess-1', s => ({ ...s, messages: said('foreground answer') }))
    updateSession('tile-1', s => ({ ...s, messages: said('tile answer') }))
    vi.mocked(requestGateway).mockResolvedValue({ session_id: 'runtime-2', stored_session_id: 'stored-2' } as never)

    await run('/branch')

    expect(vi.mocked(requestGateway).mock.calls[0][0]).toBe('session.create')
    expect(vi.mocked(requestGateway).mock.calls[0][1]).toMatchObject({
      messages: [{ content: 'tile answer', role: 'assistant' }]
    })
    // ...and the foreground transcript is still its own.
    expect($sessionStates.get()['sess-1'].messages).toEqual(said('foreground answer'))
  })

  it('marks the tile as compacting while it runs, and releases it after', async () => {
    let seenOnTile = false
    let seenOnActive = false

    vi.mocked(requestGateway).mockImplementation(async () => {
      seenOnTile = sessionCompacting('tile-1').get()
      seenOnActive = sessionCompacting('sess-1').get()

      return { summary: { headline: 'compacted' } } as never
    })

    await run('/compress')

    expect(seenOnTile).toBe(true)
    expect(seenOnActive).toBe(false)
    expect($compactingSessions.get()).toEqual({})
  })
})
