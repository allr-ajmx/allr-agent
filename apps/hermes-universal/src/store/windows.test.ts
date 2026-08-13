/**
 * Writing the composer down before a window is built (MJXHRM-398).
 *
 * Every window kind here boots the app, and the app seeds its per-session drafts
 * from `localStorage` as it mounts. That stash is only ever as current as the
 * last debounced write — 400 ms — so unless the window ORDERING a new one writes
 * its editor down first, the new window opens on the sentence as it stood a
 * moment ago and the rest is gone.
 *
 * `app/hud/hud.ts` was the only opener that had ever done this. Three others had
 * not, which is the defect: tearing a tile off, popping a chat out, and opening
 * a new instance window. So the assertions here are all about ORDER — the flush
 * has to be on the wire before `invoke` is, not merely somewhere in the function
 * — and about the guards, because a window that is never built must leave no
 * trace in the shared stash.
 *
 * The addressing half (`addressesThisWindow`) is at the bottom: it is what lets
 * a peer flush reach a DETACHED TILE window, which is not a satellite and so had
 * no address at all before this.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Every cross-module call in order. */
const calls: string[] = []

const invoke = vi.fn(async (command: string, _args?: unknown) => {
  calls.push(`invoke:${command}`)

  if (command === 'open_satellite_window') {
    return { grant: null, label: 'sat-hud' }
  }

  return 'tile-session-tile-abc'
})

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/app', () => ({ supportsMultipleWindows: async () => true }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    close: async () => undefined,
    onCloseRequested: async () => () => undefined
  }),
  WebviewWindow: { getByLabel: async () => null }
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

vi.mock('@/lib/composer-draft-bus', () => ({
  requestComposerDraftSync: (mode: string) => {
    calls.push(`sync:${mode}`)
  }
}))

vi.mock('@/lib/route-nav', () => ({ navigateTo: () => calls.push('navigate') }))
vi.mock('@/store/notifications', () => ({ notifyError: () => calls.push('notify-error') }))
vi.mock('./popout-transport', () => ({ notePopoutWindow: () => calls.push('note-popout') }))

/** The platform gate every opener sits behind. Settable, because "this build
 *  cannot open a second window" is the case that must leave no trace. */
const platform = vi.hoisted(() => ({ android: false, desktop: true, ios: false, tauri: true }))

vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get IS_ANDROID() {
    return platform.android
  },
  get IS_DESKTOP() {
    return platform.desktop
  },
  get IS_IOS() {
    return platform.ios
  },
  get IS_TAURI() {
    return platform.tauri
  }
}))

const {
  addressesThisWindow,
  openNewWindow,
  openSatelliteWindow,
  openSessionInNewWindow,
  openSettingsScreen,
  openTileWindow
} = await import('./windows')

beforeEach(() => {
  calls.length = 0
  invoke.mockClear()
  platform.android = false
  platform.desktop = true
})

describe('flushing the composer before a window is built', () => {
  it('writes the draft down before the tile window is asked for', async () => {
    await openTileWindow('session-tile:abc', { sessionId: 'abc' })

    // Reversed, the tile's host mounts, reads a stash that is up to 400 ms stale,
    // paints it, and only then does this window write the rest — into a composer
    // whose slot has by then become a placeholder. This is the ticket's bug.
    expect(calls.slice(0, 2)).toEqual(['sync:flush', 'invoke:open_tile_window'])
  })

  it('writes the draft down before a chat is popped out', async () => {
    await openSessionInNewWindow('abc')

    expect(calls.slice(0, 2)).toEqual(['sync:flush', 'invoke:open_session_window'])
  })

  it('writes the draft down before a new instance window', async () => {
    await openNewWindow()

    // A fresh window boots on the last session and reads the same stash, so it
    // loses the same keystrokes.
    expect(calls.slice(0, 2)).toEqual(['sync:flush', 'invoke:open_instance_window'])
  })

  it('writes the draft down before a satellite', async () => {
    await openSatelliteWindow('hud', '/abc123')

    // The one path that always did this — from `openHud`, which no longer needs
    // to, because it happens here for every caller.
    expect(calls.slice(0, 2)).toEqual(['sync:flush', 'invoke:open_satellite_window'])
  })

  it('writes the draft down before an Android screen activity', async () => {
    platform.android = true

    await openSettingsScreen()

    expect(calls.slice(0, 2)).toEqual(['sync:flush', 'invoke:open_screen_window'])
  })

  it('leaves no trace when the platform cannot open the window at all', async () => {
    platform.desktop = false

    await openTileWindow('session-tile:abc')
    await openSessionInNewWindow('abc')
    await openNewWindow()
    await openSatelliteWindow('hud')

    // A flush makes the shared stash authoritative for a composer that will never
    // mount to read it — and on a single-window platform that composer is the one
    // the user is still typing in.
    expect(calls).toEqual([])
  })

  it('leaves no trace when the caller named nothing to open', async () => {
    await openTileWindow('')
    await openSessionInNewWindow('')
    await openSatelliteWindow('Not A Surface')

    expect(calls).toEqual([])
  })

  it('still flushed even though the window could not be built', async () => {
    invoke.mockImplementationOnce(async (command: string) => {
      calls.push(`invoke:${command}`)

      throw new Error('no window system')
    })

    expect(await openTileWindow('session-tile:abc')).toBeNull()

    // The text was already on disk before the attempt, which is the right end
    // state: it is the user's, not the window's.
    expect(calls).toEqual(['sync:flush', 'invoke:open_tile_window', 'notify-error'])
  })

  it('flushes synchronously, with nothing awaited in between', () => {
    // `openTileWindow` is async, so everything up to its first `await` runs on
    // this tick. If the flush ever moved behind one, the new window's mount would
    // race the write it is about to read — and a race that usually wins is the
    // worst kind of regression to catch.
    void openTileWindow('session-tile:abc')

    expect(calls).toEqual(['sync:flush', 'invoke:open_tile_window'])
  })
})

describe('addressing one window out of several', () => {
  // `?win=` and `?tile=` are the only things a webview knows about itself
  // synchronously, and both come off its own URL.
  function inWindow(search: string): void {
    window.history.replaceState({}, '', `/${search}`)
  }

  it('names the ordinary window with a fully null address', () => {
    inWindow('')

    expect(addressesThisWindow({ surface: null, tile: null })).toBe(true)
    expect(addressesThisWindow({ surface: 'hud', tile: null })).toBe(false)
    expect(addressesThisWindow({ surface: null, tile: 'session-tile:abc' })).toBe(false)
  })

  it('names a detached tile window by its tile, not by a surface', () => {
    inWindow('?win=tile&tile=session-tile:abc')

    expect(addressesThisWindow({ surface: null, tile: 'session-tile:abc' })).toBe(true)
    // The bug this fixes on the reattach side: a tile window reads `surface: null`
    // exactly like the main window, so a surface alone can never reach it.
    expect(addressesThisWindow({ surface: null, tile: null })).toBe(false)
  })

  it('tells two detached tile windows apart', () => {
    inWindow('?win=tile&tile=session-tile:abc')

    expect(addressesThisWindow({ surface: null, tile: 'session-tile:zzz' })).toBe(false)
  })

  it('does not let a tile window answer for a satellite, or the reverse', () => {
    inWindow('?win=tile&tile=session-tile:abc')

    expect(addressesThisWindow({ surface: 'hud', tile: null })).toBe(false)
  })
})
