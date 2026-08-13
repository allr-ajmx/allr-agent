/**
 * Summoning the HUD (MJXHRM-213).
 *
 * Two things decide whether the handoff feels like one app or two: the HUD has
 * to open on the conversation the user was looking at, and a half-typed message
 * has to be written down BEFORE the new window goes looking for it. Both are
 * ordering, and ordering is what regresses silently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const open = vi.fn(async (_surface: string, _route?: string) => 'sat-hud' as null | string)
const close = vi.fn(async (_surface: string) => undefined)
const isOpen = vi.fn(async (_surface: string) => false)
const sync = vi.fn()
const peerFlush = vi.fn(async (_surface: string) => true)
/** Whether the window running the test IS the HUD. Settable, because `closeHud`
 *  runs in both and only one of them may ask a peer for its draft. */
let inSatellite = false
/** Every cross-module call in order — the assertions are about sequence. */
const calls: string[] = []

vi.mock('@/store/windows', () => ({
  closeSatelliteWindow: (surface: string) => {
    calls.push('close')

    return close(surface)
  },
  HUD_SURFACE: 'hud',
  isSatelliteWindow: () => inSatellite,
  isSatelliteWindowOpen: (surface: string) => isOpen(surface),
  openSatelliteWindow: (surface: string, route?: string) => {
    calls.push('open')

    return open(surface, route)
  }
}))

vi.mock('@/lib/composer-draft-bus', () => ({
  requestComposerDraftSync: (mode: string) => {
    calls.push(`sync:${mode}`)
    sync(mode)
  }
}))

vi.mock('@/store/composer', () => ({
  requestPeerComposerFlush: (address: { surface: null | string }) => {
    calls.push(`peer-flush:${address.surface}`)

    return peerFlush(address.surface as string)
  }
}))

/** The capability gate. Settable, because "can this platform float a window"
 *  is the one input that changes what `openHud` is allowed to do. */
let floatingSurface = true

vi.mock('@/lib/surface', () => ({
  surfaceCapabilities: async () => ({ floatingSurface })
}))

// The return trip (MJXHRM-371). Mocked so the ORDER is observable: without it the
// real module simply stands down off Tauri and openHud could stop calling it
// entirely with every test here still green.
vi.mock('./handoff', () => ({
  installHudHandoff: () => {
    calls.push('arm')
  },
  noteHudSummoned: () => {
    calls.push('claim')
  }
}))

const { closeHud, hudTargetSessionId, openHud, toggleHud } = await import('./hud')

function atRoute(hash: string): void {
  window.location.hash = hash
}

beforeEach(() => {
  calls.length = 0
  open.mockClear()
  close.mockClear()
  sync.mockClear()
  peerFlush.mockClear()
  peerFlush.mockResolvedValue(true)
  isOpen.mockResolvedValue(false)
  atRoute('')
  floatingSurface = true
  inSatellite = false
})

describe('which conversation the HUD opens on', () => {
  it('follows the route the summoning window is showing', () => {
    atRoute('#/abc123')

    expect(hudTargetSessionId()).toBe('abc123')
  })

  it('is nothing on the new-chat route', () => {
    atRoute('#/')

    expect(hudTargetSessionId()).toBeNull()
  })

  it('is nothing on a reserved screen', () => {
    atRoute('#/settings')

    expect(hudTargetSessionId()).toBeNull()
  })

  it('carries the session into the window it opens', async () => {
    atRoute('#/abc123')
    await openHud()

    expect(open).toHaveBeenCalledWith('hud', '/abc123')
  })

  it('opens on the new-chat route with no session at all', async () => {
    await openHud(null)

    // No session: the HUD opens on the app's root route, not on a stale one.
    expect(open).toHaveBeenCalledWith('hud', undefined)
  })
})

describe('the capability gate', () => {
  // `lib/surface.ts` states the rule: read `floatingSurface` before offering the
  // affordance. The titlebar hides its button (see titlebar.test.tsx), but a
  // hotkey — including the OS-wide chord claimed at boot — never sees a hidden
  // button, so the refusal has to live here as well.
  it('refuses to summon where the platform has no floating surface', async () => {
    floatingSurface = false

    expect(await openHud('abc123')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves no trace of a summon that could not happen', async () => {
    floatingSurface = false

    await openHud('abc123')

    // Not even the draft flush: it makes the shared stash authoritative for a
    // HUD composer that will never mount to read it, and arming the return trip
    // would leave a listener waiting on a window nobody opened.
    expect(calls).toEqual([])
  })

  it('still summons where the platform can float one', async () => {
    expect(await openHud('abc123')).toBe(true)
    expect(open).toHaveBeenCalled()
  })
})

describe('the transport handoff', () => {
  it('arms the return trip before the HUD exists, and claims it once it does', async () => {
    await openHud('abc123')

    // Armed BEFORE: a HUD dismissed the instant it appears would otherwise close
    // before anything was listening. Claimed AFTER, and only on success: the
    // claim says "this window put that HUD on screen", which a failed summon did
    // not do — and a peer app window hears the same native close.
    expect(calls).toEqual(['arm', 'open', 'claim'])
  })

  it('claims nothing when the HUD could not be opened', async () => {
    open.mockResolvedValueOnce(null)

    expect(await openHud('abc123')).toBe(false)
    expect(calls).not.toContain('claim')
  })
})

describe('the draft handoff', () => {
  it('does not flush on the way out of THIS module any more', async () => {
    await openHud('abc123')

    // The flush still happens, and still before the window exists — it moved
    // into `openSatelliteWindow` and its three siblings, because this was the
    // only opener that ever had one and three others were building windows that
    // read the stash without writing to it first (MJXHRM-398). Pinned there, in
    // `store/windows.test.ts`; `openSatelliteWindow` is mocked here, so a flush
    // appearing in this list again would mean a second one was reintroduced.
    expect(calls).not.toContain('sync:flush')
  })

  it('flushes before tearing the HUD down, this window first and then the HUD', async () => {
    await closeHud()

    // `closeHud` may be running INSIDE the HUD, so its own text has to reach the
    // stash without racing the window's destruction — and when it is not, the
    // text at risk is in the OTHER webview, which no DOM event of ours reaches
    // and which runs nothing on the way out. Both flushes complete before the
    // close: reversed, the window holding the draft is already gone.
    //
    // This window before the HUD, because the two are normally on the SAME
    // conversation: the later write wins, and the one being destroyed is the one
    // whose copy has to survive.
    expect(calls).toEqual(['sync:flush', 'peer-flush:hud', 'close'])
  })

  it('does not ask a peer for a draft when the HUD is the window closing itself', async () => {
    inSatellite = true

    await closeHud()

    // Its own flush above already wrote the text down. Asking would only invite
    // the main window's older copy of the same conversation to land on top of it.
    expect(calls).toEqual(['sync:flush', 'close'])
  })

  it('tears the HUD down even when nobody answered the flush', async () => {
    peerFlush.mockResolvedValue(false)

    await closeHud()

    // An unanswered flush means the window was already gone or had no bus — the
    // draft is not recoverable either way, and refusing to close would strand a
    // HUD the user asked to dismiss.
    expect(calls).toEqual(['sync:flush', 'peer-flush:hud', 'close'])
  })
})

describe('toggling', () => {
  it('dismisses one that is up', async () => {
    isOpen.mockResolvedValue(true)

    expect(await toggleHud()).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('summons one that is not', async () => {
    expect(await toggleHud()).toBe(true)
    expect(close).not.toHaveBeenCalled()
  })
})
