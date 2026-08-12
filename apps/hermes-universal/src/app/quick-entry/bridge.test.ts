/**
 * The primary window's half of Quick Entry (MJXHRM-384).
 *
 * The whole feature is one sentence typed from inside another application, so
 * the only failures worth the name are the ones where that sentence goes
 * nowhere. Two of them live here:
 *
 *  - the target chat is mid-turn. `sendPrompt` opens with `if (!trimmed ||
 *    $busy.get()) return`, and by the time it runs the quick window has already
 *    cleared its draft and closed itself — so the text was gone with no send, no
 *    queue entry and no toast. It has to land in the composer's queue instead.
 *  - the picked session is stale. The delegate rejects; the prompt must fall
 *    back to the current chat rather than be swallowed.
 *
 * The third case is the one no user reports: the bridge outlives the window it
 * serves, so it kept broadcasting state to a window that closed minutes ago.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const makeAtom = <T>(initial: T) => {
    let value = initial
    const subs = new Set<() => void>()

    return {
      get: () => value,
      listen: (fn: () => void) => {
        subs.add(fn)

        return () => {
          subs.delete(fn)
        }
      },
      set: (next: T) => {
        value = next

        for (const sub of [...subs]) {
          sub()
        }
      }
    }
  }

  return {
    $activeSessionKey: makeAtom('runtime-current'),
    $busy: makeAtom(false),
    $connectionPhase: makeAtom('ready'),
    $sessions: makeAtom([] as { archived?: boolean; id: string; title?: string }[])
  }
})

const sendPrompt = vi.fn(async (_text: string) => undefined)
const enqueueQueuedPrompt = vi.fn((_key: string, _payload: { attachments: unknown[]; text: string }) => ({ id: 'q1' }))
const startNewSession = vi.fn()
const resumeTile = vi.fn(async (_storedId: string) => 'runtime-picked')
const submitToSession = vi.fn(async (_runtimeId: string, _text: string) => undefined)
const emitQuickEntryState = vi.fn(async () => undefined)

let delegate: null | { resumeTile: typeof resumeTile; submitToSession: typeof submitToSession } = null
let secondaryWindow = false

/** Handlers the bridge registered, so the test can play the other window. */
let onSubmit: ((raw: unknown) => void) | null = null
let onHello: (() => void) | null = null
const closeListeners: ((event: { payload: string }) => void)[] = []

vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))
vi.mock('@/store/chat', () => ({ $busy: h.$busy, sendPrompt }))
vi.mock('@/store/session-state-types', () => ({ $activeSessionKey: h.$activeSessionKey }))
vi.mock('@/store/composer-queue', () => ({ enqueueQueuedPrompt }))
vi.mock('@/store/new-session', () => ({ startNewSession }))
vi.mock('@/store/connection', () => ({ $connectionPhase: h.$connectionPhase }))
vi.mock('@/store/session', () => ({ $sessions: h.$sessions }))
vi.mock('@/store/session-states', () => ({ sessionTileDelegate: () => delegate }))
vi.mock('./quick-entry', () => ({ QUICK_ENTRY_SURFACE: 'quick' }))

vi.mock('@/store/windows', () => ({
  isSecondaryWindow: () => secondaryWindow,
  SATELLITE_WINDOW_CLOSED_EVENT: 'hermes://satellite-window-closed',
  satelliteSurfaceFromLabel: (label: string) => (label.startsWith('sat-') ? label.slice(4) : null)
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, handler: (event: { payload: string }) => void) => {
    closeListeners.push(handler)

    return () => undefined
  }
}))

vi.mock('./channel', () => ({
  emitQuickEntryState,
  onQuickEntryHello: async (handler: () => void) => {
    onHello = handler

    return () => undefined
  },
  onQuickEntrySubmit: async (handler: (raw: unknown) => void) => {
    onSubmit = handler

    return () => undefined
  }
}))

/** The bridge routes a submit through a chain of dynamic imports; drain them. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

async function install() {
  const mod = await import('./bridge')

  mod.resetQuickEntryBridge()
  mod.installQuickEntryBridge()
  await flush()

  return mod
}

/** What the compositor's close of `sat-quick` looks like from in here: a native
 *  event, and no JS teardown in the window that went away. */
function closeQuickWindowNatively(): void {
  for (const listener of closeListeners) {
    listener({ payload: 'sat-quick' })
  }
}

beforeEach(() => {
  sendPrompt.mockClear()
  enqueueQueuedPrompt.mockClear()
  startNewSession.mockClear()
  resumeTile.mockClear()
  submitToSession.mockClear()
  emitQuickEntryState.mockClear()
  onSubmit = null
  onHello = null
  closeListeners.length = 0
  delegate = null
  secondaryWindow = false
  h.$busy.set(false)
  h.$connectionPhase.set('ready')
  h.$activeSessionKey.set('runtime-current')
  h.$sessions.set([])
})

describe('a captured prompt always lands somewhere', () => {
  it('sends into the current chat when it is idle', async () => {
    await install()

    onSubmit?.({ target: 'current', text: 'ship it' })
    await flush()

    expect(sendPrompt).toHaveBeenCalledWith('ship it')
    expect(enqueueQueuedPrompt).not.toHaveBeenCalled()
  })

  it('QUEUES rather than dropping when the current chat is mid-turn', async () => {
    await install()
    h.$busy.set(true)

    onSubmit?.({ target: 'current', text: 'also add tests' })
    await flush()

    // The window has already closed and cleared its draft; a silent `sendPrompt`
    // bail is the sentence disappearing.
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(enqueueQueuedPrompt).toHaveBeenCalledWith('runtime-current', { attachments: [], text: 'also add tests' })
  })

  it('queues under the key the primary composer drains — its active session key', async () => {
    await install()
    h.$busy.set(true)
    h.$activeSessionKey.set('runtime-other')

    onSubmit?.({ target: 'current', text: 'follow-up' })
    await flush()

    expect(enqueueQueuedPrompt).toHaveBeenCalledWith('runtime-other', { attachments: [], text: 'follow-up' })
  })

  it('starts a fresh chat and submits into it for the New session target', async () => {
    await install()

    onSubmit?.({ target: 'new', text: 'a brand new thought' })
    await flush()

    expect(startNewSession).toHaveBeenCalled()
    expect(sendPrompt).toHaveBeenCalledWith('a brand new thought')
  })

  it('runs a picked session in the background through the tile delegate', async () => {
    delegate = { resumeTile, submitToSession }
    await install()

    onSubmit?.({ target: 'stored-42', text: 'for that other chat' })
    await flush()

    expect(resumeTile).toHaveBeenCalledWith('stored-42')
    expect(submitToSession).toHaveBeenCalledWith('runtime-picked', 'for that other chat')
    // The primary view must not jump, so nothing goes through sendPrompt.
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('falls back to the current chat when the picked session has gone stale', async () => {
    resumeTile.mockRejectedValueOnce(new Error('session not found'))
    delegate = { resumeTile, submitToSession }
    await install()

    onSubmit?.({ target: 'deleted-7', text: 'must not vanish' })
    await flush()

    expect(submitToSession).not.toHaveBeenCalled()
    expect(sendPrompt).toHaveBeenCalledWith('must not vanish')
  })

  it('queues the fallback too when the current chat is busy', async () => {
    resumeTile.mockRejectedValueOnce(new Error('session not found'))
    delegate = { resumeTile, submitToSession }
    await install()
    h.$busy.set(true)

    onSubmit?.({ target: 'deleted-7', text: 'still must not vanish' })
    await flush()

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(enqueueQueuedPrompt).toHaveBeenCalledWith('runtime-current', {
      attachments: [],
      text: 'still must not vanish'
    })
  })

  it('ignores a payload with no text — an empty capture is not a prompt', async () => {
    await install()

    onSubmit?.({ target: 'current', text: '   ' })
    await flush()

    expect(sendPrompt).not.toHaveBeenCalled()
    expect(enqueueQueuedPrompt).not.toHaveBeenCalled()
  })
})

describe('the bridge belongs to the primary window only', () => {
  it('refuses to install in a satellite or tile window', async () => {
    secondaryWindow = true

    const mod = await import('./bridge')
    mod.resetQuickEntryBridge()
    mod.installQuickEntryBridge()
    await flush()

    // A second window also claiming the capture channel is one keystroke, N
    // prompts.
    expect(onSubmit).toBeNull()
  })
})

describe('state pushes stop when the quick window does', () => {
  it('pushes while the window is up', async () => {
    await install()
    emitQuickEntryState.mockClear()

    h.$sessions.set([{ id: 's1', title: 'One' }])

    expect(emitQuickEntryState).toHaveBeenCalledTimes(1)
  })

  it('stops pushing after a NATIVE close, which runs no teardown here', async () => {
    await install()
    closeQuickWindowNatively()
    emitQuickEntryState.mockClear()

    h.$sessions.set([{ id: 's1', title: 'One' }])
    h.$connectionPhase.set('offline')

    expect(emitQuickEntryState).not.toHaveBeenCalled()
  })

  it('re-arms on the next summon', async () => {
    const mod = await install()
    closeQuickWindowNatively()
    expect(mod.quickEntryWindowIsUp()).toBe(false)

    mod.installQuickEntryBridge()
    emitQuickEntryState.mockClear()

    h.$sessions.set([{ id: 's2', title: 'Two' }])

    expect(emitQuickEntryState).toHaveBeenCalledTimes(1)
  })

  it('re-arms on a hello from a window this one did not summon', async () => {
    await install()
    closeQuickWindowNatively()
    emitQuickEntryState.mockClear()

    onHello?.()
    h.$sessions.set([{ id: 's3', title: 'Three' }])

    // The hello's own answer, plus the push that follows it.
    expect(emitQuickEntryState).toHaveBeenCalledTimes(2)
  })

  it('ignores another satellite closing', async () => {
    await install()

    for (const listener of closeListeners) {
      listener({ payload: 'sat-hud' })
    }

    emitQuickEntryState.mockClear()
    h.$sessions.set([{ id: 's4', title: 'Four' }])

    expect(emitQuickEntryState).toHaveBeenCalledTimes(1)
  })
})

describe('the pushed state', () => {
  it('reports the gateway as reachable only when the connection is ready', async () => {
    const mod = await install()

    expect(mod.quickEntryStatePush().connected).toBe(true)

    h.$connectionPhase.set('connecting')
    expect(mod.quickEntryStatePush().connected).toBe(false)
  })

  it('offers live sessions only', async () => {
    const mod = await install()

    h.$sessions.set([
      { archived: true, id: 'dead', title: 'Archived' },
      { id: 'live', title: 'Live' }
    ])

    expect(mod.quickEntryStatePush().sessions).toEqual([{ id: 'live', title: 'Live' }])
  })
})
