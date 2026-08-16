/**
 * DETACHED TILES — `placement: 'detached'` (MJXHRM-173).
 *
 * A detached tile is hosted by another native window. The tree KEEPS its slot:
 * the tab stays, the zone keeps its size, and the body shows a placeholder that
 * offers to bring it back. That is what makes reattach well-defined — the
 * alternative (removing it from the tree) turns "put it back" into a fresh
 * placement decision, which is the thing detach must not do.
 *
 * ── Why this is not persisted ────────────────────────────────────────────────
 * Closing the window reattaches, and an app restart brings every tile home. A
 * persisted detach set would mean re-spawning windows at boot, and healing the
 * cases where the tile no longer registers (a plugin that failed to load, a
 * session that was deleted) — real work for a state nobody asked to survive a
 * relaunch. So this is module state, deliberately.
 *
 * ── Why a Map, keyed to the window LABEL ─────────────────────────────────────
 * The label is slugged from the tile id in Rust (`session-tile:x` ->
 * `tile-session-tile-x`), so it can't be recomputed here without duplicating
 * that slug. `open_tile_window` returns the label it built and the close event
 * reports the same string, so the pair is stored and matched, never derived.
 *
 * This lives beside the tile contract rather than in `tree/store.ts` on purpose:
 * detach is a property of a TILE, and the store is already the epic's god-module.
 */

import { atom } from 'nanostores'

import { storedIdFromTilePane } from '@/lib/pane-ids'
import { requestPeerComposerFlush } from '@/store/composer'
import { closeTileWindow, openTileWindow, TILE_WINDOW_CLOSED_EVENT } from '@/store/windows'

import type { TileId } from './types'

/** Detached tile id -> the label of the window hosting it. */
export const $detachedTiles = atom<ReadonlyMap<TileId, string>>(new Map())

export const isTileDetached = (id: TileId): boolean => $detachedTiles.get().has(id)

function setDetached(id: TileId, label: null | string) {
  const next = new Map($detachedTiles.get())

  if (label === null) {
    if (!next.delete(id)) {
      return
    }
  } else {
    next.set(id, label)
  }

  $detachedTiles.set(next)
}

/**
 * Move a tile into its own window. A chat tile carries its session id along, so
 * the host window can resume it — the tile id alone doesn't reach a transcript.
 *
 * Marked detached only AFTER the window exists: a failed open (unsupported
 * platform, build error) must leave the tile where it is rather than replacing
 * it with a placeholder pointing at a window that never appeared.
 */
export async function detachTile(id: TileId): Promise<void> {
  if (isTileDetached(id)) {
    return
  }

  const label = await openTileWindow(id, { sessionId: storedIdFromTilePane(id) ?? undefined })

  if (label) {
    setDetached(id, label)
  }
}

/**
 * Put a tile back in its slot and close the window that was hosting it.
 *
 * The draft comes home first, and it has to happen in that order (MJXHRM-398).
 * Two things below would each strand a half-typed message on their own: filling
 * the slot back in mounts a composer that seeds itself from the shared stash,
 * which is only as current as the host window's last 400 ms debounce; and
 * closing that window destroys a webview from OUTSIDE it, which runs no JS there
 * at all — the same reason the close has to be announced from Rust. So the host
 * is ASKED, and the ask is awaited: `requestPeerComposerFlush` resolves once that
 * window says the text is on disk, and takes it into this window's map.
 *
 * The mirror of dismissing the HUD (MJXHRM-424, `app/hud/hud.ts`) — one verb in
 * this window, the text in another — and addressed by tile rather than by
 * satellite surface, because a tile window is not a satellite.
 *
 * An unanswered flush is not fatal. It means the window was already gone, or had
 * no bus; the draft is unrecoverable either way, and refusing to reattach a tile
 * the user asked for would be the worse failure.
 */
export async function reattachTile(id: TileId): Promise<void> {
  const label = $detachedTiles.get().get(id)

  if (label === undefined) {
    return
  }

  await requestPeerComposerFlush({ surface: null, tile: id })

  setDetached(id, null)
  await closeTileWindow(label)
}

/**
 * Reattach whatever a closed window was hosting. Mount once from the primary
 * window; returns a disposer.
 *
 * The event is emitted natively on window destroy, so this covers every way a
 * window can go away — the ✕, the window menu, the compositor — not just the
 * reattach verb, which has already cleaned up by the time the close lands.
 */
export function watchDetachedTileWindows(): () => void {
  let dispose: (() => void) | undefined
  let cancelled = false

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')

      const stop = await listen<string>(TILE_WINDOW_CLOSED_EVENT, event => {
        for (const [id, label] of $detachedTiles.get()) {
          if (label === event.payload) {
            setDetached(id, null)
          }
        }
      })

      if (cancelled) {
        stop()
      } else {
        dispose = stop
      }
    } catch {
      // No Tauri event bus (web/test) — detach isn't reachable there either.
    }
  })()

  return () => {
    cancelled = true
    dispose?.()
  }
}
