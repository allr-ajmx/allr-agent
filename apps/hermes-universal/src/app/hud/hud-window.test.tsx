/**
 * The HUD's rendering contract (MJXHRM-438).
 *
 * There was no test file here at all, and that is most of why the feature could
 * be dead code for its whole life: the band state lived in CSS, in a window that
 * only ever opened on a chord over other applications, so nothing could observe
 * it. Everything asserted below is now DRIVEN FROM REACT for exactly that
 * reason — `data-hud-band-state` is a value on an element rather than a
 * `:has()`, and that is what makes the stylesheet's own contract assertable.
 *
 * Its companion is `src/styles.hud-contract.test.ts`, which fails if a
 * `html[data-hud]` selector names something no component renders.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NotificationsModule from '@/store/notifications'
import type * as SessionModule from '@/store/session'

/** Real atoms: `$messages` / `$busy` are `computed` over the session slice in
 *  the real module, so they cannot be `.set()` from a test. */
const chat = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')

  return {
    $busy: atom(false),
    $messages: atom<{ id: string; parts: { text: string; type: 'text' }[]; role: string }[]>([])
  }
})

/**
 * `navigateTo` both RECORDS and actually navigates the router under test.
 *
 * Recording alone would make "does not re-resume a session this window already
 * has" unfalsifiable: with the route frozen, the resume effect never sees a new
 * target, so it could not have re-resumed whether or not the guard exists. The
 * mutation that removes the guard has to be able to turn a test red, and only a
 * real route change gives it something to be wrong about.
 */
const nav = vi.hoisted(() => ({
  go: null as null | ((to: string) => void),
  navigateTo: vi.fn((to: string) => nav.go?.(to))
}))

const remembered = vi.hoisted(() => ({ id: null as null | string }))
/** Every `{ open }` the metrics hook was handed, in order — the seam between the
 *  band state and the OS-window resize. Nothing downstream of it is observable
 *  from jsdom, so the argument itself is what gets pinned. */
const metrics = vi.hoisted(() => ({ open: [] as boolean[] }))

vi.mock('@/app/chat/chat-screen', () => ({ ChatScreen: () => <div data-testid="chat-screen">chat</div> }))
vi.mock('@/components/notifications', () => ({ NotificationStack: () => null }))
vi.mock('@/lib/route-nav', () => ({ navigateTo: nav.navigateTo }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@/store/notifications', async importActual => ({
  ...(await importActual<typeof NotificationsModule>()),
  notify: vi.fn()
}))
vi.mock('@/store/chat', async importActual => ({
  ...((await importActual()) as Record<string, unknown>),
  ...chat
}))
vi.mock('@/store/session', async importActual => ({
  ...(await importActual<typeof SessionModule>()),
  lastOpenedSessionId: () => remembered.id,
  openSession: vi.fn().mockResolvedValue(undefined),
  refreshSessions: vi.fn().mockResolvedValue(undefined)
}))
// jsdom has no ResizeObserver and no compositor. What this window does with the
// measurements is `hud-size.test.ts`'s subject; what belongs HERE is which band
// state it hands over.
vi.mock('./use-hud-surface', () => ({
  useHudCardMetrics: (_ref: unknown, value: { open: boolean }) => {
    metrics.open.push(value.open)
  },
  useHudGrant: () => null,
  useTransparentDocument: () => {}
}))
vi.mock('./hud', () => ({ closeHud: vi.fn().mockResolvedValue(undefined), HUD_SURFACE: 'hud' }))
vi.mock('./handoff', () => ({ reportHudSession: vi.fn() }))

import { $connectionError, $connectionPhase } from '@/store/connection'
import { $activeStoredSessionId, openSession } from '@/store/session'

import { closeHud } from './hud'
import { HudWindowRoot } from './hud-window'

const turn = (id: string) => ({ id, parts: [{ text: 'hello', type: 'text' as const }], role: 'assistant' })

/** Hands the test the router's own `navigate`, so the `navigateTo` mock above
 *  can move the window for real. */
function RouterHandle() {
  nav.go = useNavigate()

  return null
}

function summonAt(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RouterHandle />
      <HudWindowRoot />
    </MemoryRouter>
  )
}

function bandState(container: HTMLElement): null | string {
  return container.querySelector('[data-hud-card]')?.getAttribute('data-hud-band-state') ?? null
}

beforeEach(() => {
  vi.clearAllMocks()
  chat.$busy.set(false)
  chat.$messages.set([])
  remembered.id = null
  nav.go = null
  metrics.open.length = 0
  $connectionPhase.set('ready')
  $connectionError.set(null)
  $activeStoredSessionId.set(null)
})

afterEach(cleanup)

describe('the HUD at rest', () => {
  // What shipped instead was `ChatScreen` verbatim in a 560x260 box: a header, a
  // scrolling transcript and a docked composer — a miniature chat window.
  it('is a bar and nothing else on a blank new chat', () => {
    const { container } = summonAt('/')

    expect(bandState(container)).toBe('collapsed')
    // The bar is the REAL composer, not a second one — the whole chat screen is
    // still mounted, the stylesheet reflows it.
    expect(container.querySelector('[data-testid="chat-screen"]')).not.toBeNull()
  })

  it('opens with its tail on a session that already has one', () => {
    chat.$messages.set([turn('a1')])

    const { container } = summonAt('/abc')

    expect(bandState(container)).toBe('open')
  })

  it('tells the window-resize seam which state it is in', async () => {
    chat.$messages.set([turn('a1')])

    const { container } = summonAt('/abc')

    expect(metrics.open.at(-1)).toBe(true)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-hud-collapse]')?.click()
    })

    // The seam is what turns the panel into a window height. Handed a stale
    // `open`, the HUD would collapse visually and leave the window tall — an
    // empty transparent rectangle eating clicks under the bar.
    expect(metrics.open.at(-1)).toBe(false)
  })
})

describe('the collapse control', () => {
  it('closes the panel and keeps it closed while the reply is still arriving', async () => {
    chat.$messages.set([turn('a1')])

    const { container } = summonAt('/abc')

    expect(bandState(container)).toBe('open')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-hud-collapse]')?.click()
    })

    expect(bandState(container)).toBe('collapsed')

    // The next token must not undo the user. A control the reply re-opens is a
    // control that does not work.
    await act(async () => {
      chat.$busy.set(true)
      chat.$messages.set([turn('a1'), turn('a2')])
    })

    expect(bandState(container)).toBe('collapsed')
  })

  it('opens the panel again when it is pressed a second time', async () => {
    chat.$messages.set([turn('a1')])

    const { container } = summonAt('/abc')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-hud-collapse]')?.click()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-hud-collapse]')?.click()
    })

    expect(bandState(container)).toBe('open')
  })

  // A control for a panel that is not there is a control that does nothing.
  it('is absent while there is no conversation to hide', () => {
    const { container } = summonAt('/')

    expect(container.querySelector('[data-hud-collapse]')).toBeNull()
    expect(container.querySelector('[data-hud-exit]')).not.toBeNull()
  })
})

describe('the engaged state', () => {
  it('stays engaged for as long as a turn is running', async () => {
    vi.useFakeTimers()

    try {
      chat.$busy.set(true)

      const { container } = summonAt('/abc')

      // Well past the 1100ms activity hold: what keeps this bright now is the
      // running turn, not the hold, and fading out between tokens would be the
      // worst of both.
      await act(async () => {
        vi.advanceTimersByTime(4000)
      })

      expect(container.querySelector('[data-hud-root]')?.hasAttribute('data-hud-engaged')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fades back once the turn has been finished for a moment', async () => {
    vi.useFakeTimers()

    try {
      const { container } = summonAt('/abc')

      await act(async () => {
        vi.advanceTimersByTime(4000)
      })

      expect(container.querySelector('[data-hud-root]')?.hasAttribute('data-hud-engaged')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the connecting state', () => {
  // It used to render `t.zones.detachedMissing` — "This tile is not available in
  // this window." The HUD is not a tile and it is not missing, and a surface
  // that is a bar, then a sentence, then a bar again reads as three things.
  it('keeps the bar’s shape and says it is connecting', () => {
    $connectionPhase.set('connecting')

    const { container } = summonAt('/')

    expect(container.textContent).toContain('Connecting to Hermes…')
    expect(container.textContent).not.toContain('This tile is not available in this window.')
    expect(bandState(container)).toBe('collapsed')
  })

  it('shows the gateway’s own reason and a way to a real window when it fails', () => {
    $connectionPhase.set('error')
    $connectionError.set('connection refused')

    const { container } = summonAt('/')

    expect(container.textContent).toContain('connection refused')
    // Fixing a gateway is main-window work, and in background mode this bar may
    // be the only Hermes on screen.
    expect(container.textContent).toContain('Show Hermes')
  })

  // The resolution waits rather than gives up: `$connectionPhase` is a nanostore
  // and the resume effect is a subscription, so it fires when the phase reaches
  // `ready` without needing a re-summon.
  it('opens a blank new chat on root summon even if previous sessions exist', async () => {
    remembered.id = 'remembered-1'

    summonAt('/')

    await act(async () => {})

    expect(openSession).not.toHaveBeenCalled()
    expect(nav.navigateTo).not.toHaveBeenCalled()
  })
})

describe('which conversation a summon lands on', () => {
  it('resumes the conversation it was explicitly summoned onto in the route', async () => {
    remembered.id = 'remembered-1'

    summonAt('/from-the-route')

    await waitFor(() => expect(openSession).toHaveBeenCalledWith('from-the-route'))
    expect(openSession).not.toHaveBeenCalledWith('remembered-1')
  })

  it('opens a blank new chat when this profile has never had one', async () => {
    summonAt('/')

    // "Open a new session" means do nothing: the router is already on the
    // new-chat route and the composer creates the session on first submit.
    await act(async () => {})

    expect(openSession).not.toHaveBeenCalled()
    expect(nav.navigateTo).not.toHaveBeenCalled()
  })

  // A route id can name a conversation deleted since it was recorded.
  it('falls back to a blank new chat when the summoned route session is gone', async () => {
    vi.mocked(openSession).mockRejectedValueOnce(new Error('no such session'))

    const { container } = summonAt('/deleted-1')

    await waitFor(() => expect(openSession).toHaveBeenCalledWith('deleted-1'))
    // Not an error, and not a spinner that never resolves: the blank chat that
    // is already on screen is the answer, and the window stays a bar.
    await waitFor(() => expect(nav.navigateTo).not.toHaveBeenCalled())
    expect(bandState(container)).toBe('collapsed')
  })

  // The refusal may be the gateway restarting rather than a dead session, and a
  // HUD that latched on the first failure would sit on a blank chat for the rest
  // of its life with a perfectly good conversation one reconnect away.
  it('tries the summoned route chat again after the gateway drops and returns', async () => {
    vi.mocked(openSession).mockRejectedValueOnce(new Error('gateway restarting'))

    summonAt('/flaky-1')

    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1))

    await act(async () => {
      $connectionPhase.set('connecting')
    })
    await act(async () => {
      $connectionPhase.set('ready')
    })

    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(2))
  })
})

describe('the handoff back to the summoning window', () => {
  /**
   * MJXHRM-371's regression, reintroduced by the redesign and fixed here. A HUD
   * summoned onto a BLANK chat never navigates, so the reported session stayed
   * null, `takeReportedHudSession()` answered null, and the re-home fell back to
   * `$activeStoredSessionId` in the MAIN window — its own, different session.
   * The conversation the user just had in the HUD would be orphaned.
   */
  it('puts a session created here into the route', async () => {
    summonAt('/')

    await act(async () => {
      $activeStoredSessionId.set('born-in-the-hud')
    })

    expect(nav.navigateTo).toHaveBeenCalledWith('/born-in-the-hud')
  })

  it('does not re-resume a session this window already has', async () => {
    summonAt('/')

    await act(async () => {
      $activeStoredSessionId.set('born-in-the-hud')
    })

    // The resume latch is set BEFORE the navigate, and that ordering is
    // load-bearing: without it the resume effect sees a new target with no latch
    // and issues a redundant refresh + open against a slice that is warm.
    expect(openSession).not.toHaveBeenCalled()
  })

  it('leaves a session it was summoned onto in the route alone', async () => {
    summonAt('/abc')

    await act(async () => {
      $activeStoredSessionId.set('abc')
    })

    expect(nav.navigateTo).not.toHaveBeenCalled()
  })
})

describe('dismissing the HUD', () => {
  it('closes the HUD on Escape key press', () => {
    summonAt('/')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closeHud).toHaveBeenCalledTimes(1)
  })

  it('does not close the HUD on window blur or click outside', () => {
    const { container } = summonAt('/')
    const root = container.querySelector('[data-hud-root]')!

    window.dispatchEvent(new Event('blur'))
    fireEvent.pointerDown(root)
    expect(closeHud).not.toHaveBeenCalled()
  })
})

