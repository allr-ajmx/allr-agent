/**
 * The satellite-window URL contract (MJXHRM-173).
 *
 * `?win=secondary` was the chat pop-out's flag before the tile window
 * generalized it. A URL is a contract — an already-open window and any stored
 * link have to keep working — so it still resolves to a tile window, and the
 * only thing that changed is the code path behind it.
 *
 * These read `window.location.search` at MODULE LOAD (the flags are cached), so
 * each case re-imports against a fresh location.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cronJobRoute } from '@/app/routes'
import type * as Platform from '@/lib/platform'

const realLocation = window.location

function atSearch(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, search },
    writable: true
  })
}

const load = () => import('@/store/windows')

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation, writable: true })
  vi.resetModules()
})

describe('isTileWindow', () => {
  it('is true for the tile flag', async () => {
    atSearch('?win=tile&tile=terminal')

    expect((await load()).isTileWindow()).toBe(true)
  })

  it('is true for the legacy secondary flag', async () => {
    atSearch('?win=secondary')

    expect((await load()).isTileWindow()).toBe(true)
  })

  it('is false in the primary window', async () => {
    atSearch('')

    expect((await load()).isTileWindow()).toBe(false)
  })

  it('is false for an activity window', async () => {
    atSearch('?win=activity')

    const windows = await load()

    expect(windows.isTileWindow()).toBe(false)
    expect(windows.isActivityWindow()).toBe(true)
  })

  it('still answers the "should I own persistence?" question the nine guards ask', async () => {
    atSearch('?win=tile&tile=files')

    const windows = await load()

    // isSecondaryWindow is that predicate, widened rather than renamed — its
    // consumers (layout tree, session tiles, chat bubbles, composer pop-out)
    // must stand down in a tile window exactly as they did in a chat pop-out.
    expect(windows.isSecondaryWindow()).toBe(true)
  })

  it('stands the HUD down from owning persisted state (MJXHRM-374)', async () => {
    atSearch('?win=hud')

    const windows = await load()

    // The HUD is not a tile window, which is exactly why it used to slip
    // through: every window of this origin shares localStorage, so a HUD that
    // believed it was primary wrote over the real window's layout tree.
    expect(windows.isTileWindow()).toBe(false)
    expect(windows.isSatelliteWindow()).toBe(true)
    expect(windows.isSecondaryWindow()).toBe(true)
  })

  it('leaves the primary window owning its state', async () => {
    atSearch('')

    const windows = await load()

    expect(windows.isSatelliteWindow()).toBe(false)
    expect(windows.isSecondaryWindow()).toBe(false)
  })
})

describe('detachedTileId', () => {
  it('names the hosted tile', async () => {
    atSearch('?win=tile&tile=session-tile:abc')

    expect((await load()).detachedTileId()).toBe('session-tile:abc')
  })

  it('is null for a legacy pop-out — its target is the SESSION in the route', async () => {
    atSearch('?win=secondary')

    expect((await load()).detachedTileId()).toBeNull()
  })

  it('is null in the primary window', async () => {
    atSearch('')

    expect((await load()).detachedTileId()).toBeNull()
  })
})

/**
 * MJXHRM-420: an activity window shares this origin's localStorage, so it must
 * not write the primary window's layout/tiles/bubbles — but it still reads
 * them, because exporting a profile from the Profiles activity bundles the
 * layout tree and on Android that screen is the only way to do it.
 */
describe('ownsPersistedAppState', () => {
  it('is true in the primary window', async () => {
    atSearch('')

    const windows = await load()
    expect(windows.ownsPersistedAppState()).toBe(true)
    expect(windows.isSecondaryWindow()).toBe(false)
  })

  it('is false in an activity window, which still reads as non-secondary', async () => {
    atSearch('?win=activity')

    const windows = await load()
    expect(windows.isActivityWindow()).toBe(true)
    // The read gate stays open — only writes are withheld.
    expect(windows.isSecondaryWindow()).toBe(false)
    expect(windows.ownsPersistedAppState()).toBe(false)
  })

  it('is false in a tile window', async () => {
    atSearch('?win=tile&tile=terminal')

    expect((await load()).ownsPersistedAppState()).toBe(false)
  })

  it('is false in the legacy secondary pop-out', async () => {
    atSearch('?win=secondary')

    expect((await load()).ownsPersistedAppState()).toBe(false)
  })
})

/**
 * `satelliteLabel` accepts any lowercase word, so every `?win=` value that
 * names a window KIND — not a satellite surface — used to answer
 * `isSatelliteWindow() === true`. That mis-routed the teardown registry, the
 * HUD handoff and `canOpenSatelliteWindow`, and made `isSecondaryWindow()`
 * accidentally true for an activity window, blanking the layout tree the
 * Profiles screen needs to read in order to export a profile.
 */
describe('satelliteSurface', () => {
  it('does not claim an activity window', async () => {
    atSearch('?win=activity')

    const windows = await load()
    expect(windows.satelliteSurface()).toBeNull()
    expect(windows.isSatelliteWindow()).toBe(false)
  })

  it('does not claim a tile window or the legacy pop-out', async () => {
    atSearch('?win=tile&tile=terminal')
    expect((await load()).isSatelliteWindow()).toBe(false)

    vi.resetModules()
    atSearch('?win=secondary')
    expect((await load()).isSatelliteWindow()).toBe(false)
  })

  it('still claims a real satellite surface', async () => {
    atSearch('?win=hud')

    const windows = await load()
    expect(windows.satelliteSurface()).toBe('hud')
    expect(windows.isSatelliteWindow()).toBe(true)
    expect(windows.isSecondaryWindow()).toBe(true)
    expect(windows.ownsPersistedAppState()).toBe(false)
  })
})

/**
 * The inverse of `satelliteLabel`, and the only thing standing between a native
 * window-destroyed event and the code that acts on it: the satellite teardown
 * registry and the HUD handoff both decide what a close BELONGS to by reading a
 * surface back off a label. It is held to the same shape the label builder
 * accepts — `sat-` plus a lowercase word — because the suffix also lands in a URL
 * query and in compositor rules, and because a label that merely starts with
 * `sat-` is not one this app ever minted.
 */
describe('satelliteSurfaceFromLabel', () => {
  it('reads back a surface the label builder could have produced', async () => {
    const windows = await load()

    expect(windows.satelliteSurfaceFromLabel('sat-hud')).toBe('hud')
    expect(windows.satelliteSurfaceFromLabel('sat-quick')).toBe('quick')
    expect(windows.satelliteSurfaceFromLabel('sat-a1-b2')).toBe('a1-b2')
  })

  it('refuses every label this app never minted', async () => {
    const windows = await load()

    for (const label of [
      'main',
      'tile-terminal',
      'screen',
      'sat-',
      'sat--x',
      'sat-1hud',
      'sat-HUD',
      'sat-hud/../main'
    ]) {
      expect(windows.satelliteSurfaceFromLabel(label)).toBeNull()
    }
  })
})

/**
 * A satellite never spawns another. The HUD is the most exposed webview in the
 * app — it lives over other applications with exclusive keyboard focus — and the
 * Rust side refuses to attach a floating surface FROM one for that reason
 * (`may_attach` in src-tauri/src/surface/mod.rs). This is the frontend half of
 * the same rule, which `installHudHandoff`'s guard cites as the reason a
 * satellite can never own a handoff.
 */
describe('canOpenSatelliteWindow', () => {
  // On a platform that HAS a second window. Without this the answer is false
  // for the platform's sake and the rule under test is never reached — which is
  // exactly how this guard went uncovered.
  async function loadOnDesktop() {
    const platform = await vi.importActual<typeof Platform>('@/lib/platform')

    vi.doMock('@/lib/platform', () => ({ ...platform, IS_DESKTOP: true }))

    return load()
  }

  afterEach(() => {
    vi.doUnmock('@/lib/platform')
  })

  it('is offered in the window that can summon one', async () => {
    atSearch('')

    expect((await loadOnDesktop()).canOpenSatelliteWindow()).toBe(true)
  })

  it('is refused from inside a satellite', async () => {
    atSearch('?win=hud')

    expect((await loadOnDesktop()).canOpenSatelliteWindow()).toBe(false)
  })
})

/**
 * `openAppRoute` is the single funnel that decides whether a route becomes a
 * native screen activity or an in-app navigation, and `activitySurfaceForPath`
 * is what that activity then renders. Every call site's test mocks `openAppRoute`
 * out, so the table behind both — the one thing that has to stay in step for a
 * surface not to open as a blank Settings screen — is only exercised here.
 */
describe('the windowable-surface table', () => {
  it('resolves each surface, and its deep links, to itself', async () => {
    const { activitySurfaceForPath } = await load()

    expect(activitySurfaceForPath('/settings')).toBe('settings')
    expect(activitySurfaceForPath('/settings/providers')).toBe('settings')
    expect(activitySurfaceForPath('/command-center')).toBe('command-center')
    expect(activitySurfaceForPath('/command-center?section=system')).toBe('command-center')
    expect(activitySurfaceForPath('/cron')).toBe('cron')
    // "Manage" on a sidebar cron row deep-links to one job. On Android that
    // opens a SECOND WebView, so the id has to survive as a query — an atom
    // would not cross, and a surface lookup that ignored the query would land
    // the user on Settings.
    expect(activitySurfaceForPath('/cron?job=nightly-digest')).toBe('cron')
    expect(activitySurfaceForPath('/profiles')).toBe('profiles')
    expect(activitySurfaceForPath('/agents')).toBe('agents')
  })

  it('does not match a route that merely starts with one of them', async () => {
    const { activitySurfaceForPath } = await load()

    // `/cronjobs` is not `/cron`. A bare `startsWith` would render the Cron
    // screen for it, which is the failure this boundary exists to prevent.
    expect(activitySurfaceForPath('/cronjobs')).toBe('settings')
    expect(activitySurfaceForPath('/settingsish')).toBe('settings')
  })

  it('launches the native screen for a windowable surface and routes everything else', async () => {
    const invoke = vi.fn(async () => undefined)
    const navigateTo = vi.fn()
    const platform = await vi.importActual<typeof Platform>('@/lib/platform')

    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('@/lib/route-nav', () => ({ navigateTo }))
    vi.doMock('@/lib/platform', () => ({ ...platform, IS_ANDROID: true }))

    const { openAppRoute } = await load()

    openAppRoute('/settings/providers')
    await Promise.resolve()

    expect(invoke).toHaveBeenCalledWith('open_screen_window', { route: '/settings/providers' })
    expect(navigateTo).not.toHaveBeenCalled()

    openAppRoute('/starmap')

    expect(navigateTo).toHaveBeenCalledWith('/starmap')
    expect(invoke).toHaveBeenCalledTimes(1)

    // A deep-linked cron job must reach the native screen WITH its query intact,
    // not fall through to an in-app navigation the Android shell never shows.
    openAppRoute(cronJobRoute('nightly digest'))
    await Promise.resolve()

    expect(invoke).toHaveBeenLastCalledWith('open_screen_window', { route: '/cron?job=nightly%20digest' })
    expect(navigateTo).toHaveBeenCalledTimes(1)

    vi.doUnmock('@tauri-apps/api/core')
    vi.doUnmock('@/lib/route-nav')
    vi.doUnmock('@/lib/platform')
  })
})
