/**
 * Transport re-home for pop-out windows (MJXHRM-371).
 *
 * These are wired end to end — `store/windows.ts`'s real openers into the real
 * `popout-transport` — rather than asserting that `notePopoutWindow` was called.
 * The bug being pinned is a WIRING bug: closing a pop-out put the tile back in
 * its slot and rebound nothing, so the tab looked healthy and received no further
 * tokens. A test that stopped at "the opener told the module" would pass against
 * a module nobody ever listens to.
 *
 * The load-bearing assertion is `reclaimSessionTransport` — NOT `openSession`.
 * A plain re-open short-circuits on the warm slice, issues no `session.resume`,
 * and rebinds nothing; and `openSession` would drag the main pane onto a
 * conversation the user closed a window on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'

const invoke = vi.fn()
const reclaimSessionTransport = vi.fn(async (_storedId: string) => undefined)
const notifyError = vi.fn()
const listen = vi.fn()

/** Every registered `hermes://tile-window-closed` handler. */
const closedHandlers: ((event: { payload: string }) => void)[] = []

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }))
vi.mock('@tauri-apps/api/app', () => ({ supportsMultipleWindows: async () => true }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: string }) => void) => {
    listen(name)
    closedHandlers.push(handler)

    return () => undefined
  }
}))
vi.mock('@/store/notifications', () => ({ notifyError }))
vi.mock('@/store/session', () => ({ reclaimSessionTransport }))

// Pop-outs are a desktop/iOS affordance; `canOpenNewWindow()` gates the openers
// off otherwise and nothing would be recorded at all.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

// One module instance for the file, as in the app: re-importing under
// `vi.resetModules()` loses the dynamic-import mocks these modules rely on.
const { openSessionInNewWindow, openTileWindow } = await import('./windows')
const { resetPopoutTransport } = await import('./popout-transport')

/** Fire the native close and let the lazily-imported reclaim settle. */
async function closeWindow(label: string): Promise<void> {
  for (const handler of closedHandlers) {
    handler({ payload: label })
  }

  await new Promise(resolve => setTimeout(resolve, 0))
}

/** The listener is armed off the first recorded pop-out and not awaited by it. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  closedHandlers.length = 0
  resetPopoutTransport()
})

describe('a closed pop-out hands its session back', () => {
  it('reclaims the stream a detached chat tile was holding', async () => {
    invoke.mockResolvedValueOnce('tile-session-tile-abc')
    await openTileWindow('session-tile:abc', { sessionId: 'abc' })
    await flush()

    await closeWindow('tile-session-tile-abc')

    // TRANSPORT only. The tile is back in its slot and the user is looking at
    // whatever they were looking at; the one broken thing was the binding.
    expect(reclaimSessionTransport).toHaveBeenCalledWith('abc')
  })

  it('reclaims the stream a session pop-out was holding', async () => {
    invoke.mockResolvedValueOnce('tile-session-tile-xyz')
    await openSessionInNewWindow('xyz')
    await flush()

    // The label has to come back from Rust — the frontend cannot rebuild the slug.
    expect(invoke).toHaveBeenCalledWith('open_session_window', { sessionId: 'xyz', watch: false })

    await closeWindow('tile-session-tile-xyz')

    expect(reclaimSessionTransport).toHaveBeenCalledWith('xyz')
  })

  it('ignores a window this one did not open', async () => {
    invoke.mockResolvedValueOnce('tile-session-tile-abc')
    await openTileWindow('session-tile:abc', { sessionId: 'abc' })
    await flush()

    // A peer app window's pop-out. Both windows hear the native close; only its
    // owner may resume, or they race and the loser is left deaf.
    await closeWindow('tile-session-tile-someone-else')

    expect(reclaimSessionTransport).not.toHaveBeenCalled()
  })

  it('ignores a tile that holds no chat', async () => {
    invoke.mockResolvedValueOnce('tile-files')
    await openTileWindow('files')
    await flush()

    await closeWindow('tile-files')

    // A files/terminal tile never resumed anything, so it never took a stream.
    expect(reclaimSessionTransport).not.toHaveBeenCalled()
  })

  it('consumes the record, so re-opening the same label is needed to re-home again', async () => {
    invoke.mockResolvedValueOnce('tile-session-tile-abc')
    await openTileWindow('session-tile:abc', { sessionId: 'abc' })
    await flush()

    await closeWindow('tile-session-tile-abc')
    reclaimSessionTransport.mockClear()
    await closeWindow('tile-session-tile-abc')

    expect(reclaimSessionTransport).not.toHaveBeenCalled()
  })

  it('does not record a pop-out that failed to open', async () => {
    invoke.mockRejectedValueOnce(new Error('no window system'))
    await openTileWindow('session-tile:abc', { sessionId: 'abc' })
    await flush()

    await closeWindow('tile-session-tile-abc')

    expect(reclaimSessionTransport).not.toHaveBeenCalled()
  })

  it('surfaces a reclaim that fails rather than swallowing it', async () => {
    reclaimSessionTransport.mockRejectedValueOnce(new Error('gateway went away'))
    invoke.mockResolvedValueOnce('tile-session-tile-abc')
    await openTileWindow('session-tile:abc', { sessionId: 'abc' })
    await flush()

    await closeWindow('tile-session-tile-abc')

    // A stream that never came back looks exactly like a quiet session until the
    // next reply does not arrive.
    expect(notifyError).toHaveBeenCalled()
  })

  it('listens once however many pop-outs are opened', async () => {
    invoke.mockResolvedValueOnce('tile-session-tile-a')
    await openTileWindow('session-tile:a', { sessionId: 'a' })
    invoke.mockResolvedValueOnce('tile-session-tile-b')
    await openTileWindow('session-tile:b', { sessionId: 'b' })
    await flush()

    // Stacked listeners would resume once per pop-out ever opened.
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen).toHaveBeenCalledWith('hermes://tile-window-closed')
  })
})
