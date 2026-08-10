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
