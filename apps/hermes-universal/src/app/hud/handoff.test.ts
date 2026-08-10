/**
 * The HUD ⇄ main-window transport handoff (MJXHRM-371).
 *
 * The assertion that matters most is `forceResume: true`. Without it
 * `openSession` takes its warm-slice short-circuit, issues no `session.resume`,
 * and the gateway never rebinds — a handoff that looks complete and leaves the
 * main window deaf. A test that only checked "openSession was called" would pass
 * against exactly that bug.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners: ((event: { payload: string }) => void)[] = []

const listen = vi.fn(async (_event: string, handler: (event: { payload: string }) => void) => {
  listeners.push(handler)

  return () => undefined
})

const openSession = vi.fn(async () => undefined)
const navigateTo = vi.fn()
const reloadPersistedDrafts = vi.fn()
const requestComposerDraftSync = vi.fn()
const notifyError = vi.fn()

let activeStoredSessionId: null | string = 'session-main'
let satellite = false

vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))
vi.mock('@/lib/route-nav', () => ({ navigateTo }))
vi.mock('@/store/notifications', () => ({ notifyError }))
vi.mock('@/store/composer', () => ({ reloadPersistedDrafts, requestComposerDraftSync }))
vi.mock('@/store/session', () => ({
  $activeStoredSessionId: { get: () => activeStoredSessionId },
  openSession
}))
vi.mock('@/store/windows', () => ({
  HUD_SATELLITE: { surface: 'hud' },
  isSatelliteWindow: () => satellite,
  SATELLITE_WINDOW_CLOSED_EVENT: 'hermes://satellite-window-closed',
  satelliteSurfaceFromLabel: (label: string) => (label.startsWith('sat-') ? label.slice(4) : null)
}))

async function load() {
  const mod = await import('./handoff')
  mod.resetHudHandoff()

  return mod
}

/** Fire the native close event and let the async re-home settle. */
async function closeSatellite(label: string) {
  for (const handler of listeners) {
    handler({ payload: label })
  }

  await vi.waitFor(() => expect(openSession.mock.calls.length + notifyError.mock.calls.length).toBeGreaterThan(0))
}

describe('HUD handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listeners.length = 0
    activeStoredSessionId = 'session-main'
    satellite = false
    window.localStorage.clear()
  })

  it('reclaims the session the HUD ended on, with a FORCED resume', async () => {
    const mod = await load()

    mod.reportHudSession('session-hud')
    mod.installHudHandoff()
    await closeSatellite('sat-hud')

    // The whole point: a plain re-open would short-circuit on the warm slice and
    // rebind nothing.
    expect(openSession).toHaveBeenCalledWith('session-hud', { forceResume: true })
    // A conversation this window was not on — route to it as well.
    expect(navigateTo).toHaveBeenCalled()
    expect(reloadPersistedDrafts).toHaveBeenCalled()
    expect(requestComposerDraftSync).toHaveBeenCalledWith('reload')
  })

  it('still rebinds when the HUD stayed on this window’s own session', async () => {
    const mod = await load()

    mod.reportHudSession('session-main')
    mod.installHudHandoff()
    await closeSatellite('sat-hud')

    // Same session is NOT a no-op: the HUD held the binding for it.
    expect(openSession).toHaveBeenCalledWith('session-main', { forceResume: true })
    // Already here — no navigation.
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('falls back to the selected session when the HUD reported none', async () => {
    const mod = await load()

    mod.installHudHandoff()
    await closeSatellite('sat-hud')

    expect(openSession).toHaveBeenCalledWith('session-main', { forceResume: true })
  })

  it('consumes the reported session so a later close cannot reuse it', async () => {
    const mod = await load()

    mod.reportHudSession('session-hud')
    mod.installHudHandoff()
    await closeSatellite('sat-hud')

    openSession.mockClear()
    activeStoredSessionId = 'session-other'
    await closeSatellite('sat-hud')

    // Not 'session-hud' again — a stale id would drag the window back onto a
    // conversation the user has since left.
    expect(openSession).toHaveBeenCalledWith('session-other', { forceResume: true })
  })

  it('ignores a different satellite closing', async () => {
    const mod = await load()

    mod.installHudHandoff()

    for (const handler of listeners) {
      handler({ payload: 'sat-bubble' })
    }

    expect(openSession).not.toHaveBeenCalled()
  })

  it('installs once however many times the HUD is summoned', async () => {
    const mod = await load()

    mod.installHudHandoff()
    mod.installHudHandoff()
    mod.installHudHandoff()

    expect(listen).toHaveBeenCalledTimes(1)
  })

  it('does not install inside a satellite', async () => {
    satellite = true

    const mod = await load()

    mod.installHudHandoff()

    // A HUD re-homing onto its own transport as that transport goes away.
    expect(listen).not.toHaveBeenCalled()
  })

  it('surfaces a failed re-home rather than swallowing it', async () => {
    const mod = await load()

    openSession.mockRejectedValueOnce(new Error('gateway went away'))
    mod.reportHudSession('session-hud')
    mod.installHudHandoff()
    await closeSatellite('sat-hud')

    // A silently failed handoff looks exactly like a working one until the next
    // reply never arrives.
    expect(notifyError).toHaveBeenCalled()
  })
})
