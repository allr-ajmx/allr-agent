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
