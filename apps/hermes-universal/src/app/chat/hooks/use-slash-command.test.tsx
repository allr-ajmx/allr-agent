import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return { requestGateway: vi.fn().mockResolvedValue({}), $gatewayState: atom('open'), getGatewayClient: () => null }
})

import type * as ChatStoreModule from '@/store/chat'
import { $messages, $sessionId, resetChat, sendPrompt } from '@/store/chat'
import { $composerDraft } from '@/store/composer'
import { requestGateway } from '@/store/gateway'
import { $modelPickerOpen } from '@/store/model'
import { $sessions } from '@/store/session'
import { updateSession } from '@/store/session-state-types'
import { seedActiveSession } from '@/test-sessions'
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
})
