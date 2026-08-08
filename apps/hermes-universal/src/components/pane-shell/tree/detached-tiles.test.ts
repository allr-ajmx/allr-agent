/**
 * `placement: 'detached'` — a tile hosted by another window (MJXHRM-173).
 *
 * The invariants worth pinning are the ones a refactor could quietly break:
 * the tree KEEPS the slot, a failed window open leaves the tile alone, a close
 * reattaches, and `?win=secondary` still resolves to a tile window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openTileWindow = vi.fn()
const closeTileWindow = vi.fn()
let closedHandler: ((event: { payload: string }) => void) | undefined

vi.mock('@/store/windows', () => ({
  closeTileWindow,
  openTileWindow,
  TILE_WINDOW_CLOSED_EVENT: 'hermes://tile-window-closed'
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: string }) => void) => {
    closedHandler = handler

    return () => {
      closedHandler = undefined
    }
  })
}))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('detached tiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    closedHandler = undefined
  })

  afterEach(() => {
    vi.resetModules()
  })

  const load = () => import('@/components/pane-shell/tile/detach')

  it('marks a tile detached only once its window exists', async () => {
    const { $detachedTiles, detachTile, isTileDetached } = await load()

    openTileWindow.mockResolvedValueOnce('tile-terminal')
    await detachTile('terminal')

    expect(isTileDetached('terminal')).toBe(true)
    expect($detachedTiles.get().get('terminal')).toBe('tile-terminal')
  })

  it('leaves the tile in place when the window cannot be opened', async () => {
    const { detachTile, isTileDetached } = await load()

    // Android, or a build failure: openTileWindow reports it and returns null.
    openTileWindow.mockResolvedValueOnce(null)
    await detachTile('terminal')

    // The alternative is a placeholder pointing at a window that never appeared.
    expect(isTileDetached('terminal')).toBe(false)
  })

  it('carries the session id for a chat tile, so the host can resume it', async () => {
    const { detachTile } = await load()

    openTileWindow.mockResolvedValueOnce('tile-session-tile-abc')
    await detachTile('session-tile:abc')

    expect(openTileWindow).toHaveBeenCalledWith('session-tile:abc', { sessionId: 'abc' })
  })

  it('passes no session id for a tile that is not a chat', async () => {
    const { detachTile } = await load()

    openTileWindow.mockResolvedValueOnce('tile-files')
    await detachTile('files')

    expect(openTileWindow).toHaveBeenCalledWith('files', { sessionId: undefined })
  })

  it('does not open a second window for an already-detached tile', async () => {
    const { detachTile } = await load()

    openTileWindow.mockResolvedValueOnce('tile-terminal')
    await detachTile('terminal')
    await detachTile('terminal')

    expect(openTileWindow).toHaveBeenCalledOnce()
  })

  it('reattach clears the tile and closes its window', async () => {
    const { detachTile, isTileDetached, reattachTile } = await load()

    openTileWindow.mockResolvedValueOnce('tile-terminal')
    await detachTile('terminal')
    await reattachTile('terminal')

    expect(isTileDetached('terminal')).toBe(false)
    expect(closeTileWindow).toHaveBeenCalledWith('tile-terminal')
  })

  it('reattaching a tile that was never detached is a no-op', async () => {
    const { reattachTile } = await load()

    await reattachTile('terminal')

    expect(closeTileWindow).not.toHaveBeenCalled()
  })

  it('a closed window reattaches the tile it was hosting, and only that one', async () => {
    const { detachTile, isTileDetached, watchDetachedTileWindows } = await load()

    openTileWindow.mockResolvedValueOnce('tile-terminal')
    await detachTile('terminal')
    openTileWindow.mockResolvedValueOnce('tile-files')
    await detachTile('files')

    watchDetachedTileWindows()
    await flush()

    closedHandler?.({ payload: 'tile-terminal' })

    expect(isTileDetached('terminal')).toBe(false)
    expect(isTileDetached('files')).toBe(true)
    // The window is already gone — closing it again would be the bug.
    expect(closeTileWindow).not.toHaveBeenCalled()
  })

  it('stops listening when the watcher is disposed', async () => {
    const { detachTile, isTileDetached, watchDetachedTileWindows } = await load()

    openTileWindow.mockResolvedValueOnce('tile-terminal')
    await detachTile('terminal')

    const stop = watchDetachedTileWindows()

    await flush()
    stop()

    expect(closedHandler).toBeUndefined()
    expect(isTileDetached('terminal')).toBe(true)
  })
})
