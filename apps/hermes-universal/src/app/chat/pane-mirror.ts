/**
 * Mirror a reactive list of "tiles" into layout-tree pane contributions:
 * register a pane per tile, refresh its title in place, and dispose panes whose
 * tile is gone. This is the shared bookkeeping — a keyed registry, a wanted-set
 * diff, a one-time pane closer — behind BOTH session tiles and route (page)
 * tiles; each supplies only what differs (key, title, render, close, edge).
 */

import type { ReadableAtom } from 'nanostores'
import type { ReactElement, ReactNode, PointerEvent as ReactPointerEvent } from 'react'

import { registerTile } from '@/components/pane-shell/tile/registry'
import type { DoubleTapContext } from '@/components/pane-shell/tree/renderer/drag-session'
import { registerPaneCloser, removeTreePane, treePanesWithPrefix } from '@/components/pane-shell/tree/store'
import type { PaneStripTool } from '@/components/ui/pane-tab'
import { isRecording, recordSpan } from '@/observability'
import type { TileDock } from '@/store/session-states'

/** Matches the 1ms floor the rest of the layer uses — WebKitGTK's clock cannot
 *  resolve below it, so anything under is indistinguishable from zero. */
const SYNC_NOISE_FLOOR_MS = 1

export interface PaneMirror<T> {
  /** Reactive source list. */
  source: ReadableAtom<T[]>
  /** Extra atoms whose changes should re-sync (e.g. titles living elsewhere). */
  also?: ReadableAtom<unknown>[]
  /** Stable key + pane-id seed for a tile. */
  key: (tile: T) => string
  /** Pane-id namespace — the id is `${prefix}:${key}`. */
  prefix: string
  /** The `kind` every tile this mirror registers reports (`'chat'`, `'page'`). */
  kind: string
  /** Whether a dragged session may be LINKED into these tiles' zone (chat
   *  surfaces accept it; a page tile has nothing to link into). */
  linkTarget?: boolean
  /** What the strip's `+` does for these tiles. Session tiles contribute "new
   *  chat" so a zone holding only tiles — the workspace dragged elsewhere —
   *  still offers one. */
  onNewTab?: () => void
  /** Dock on adoption (default right; `center` = stack into anchor's zone). */
  dir?: (tile: T) => TileDock | undefined
  /** Pane to dock against (default `workspace`) — a drop's target zone. */
  anchor?: (tile: T) => string | undefined
  /** Center docks: the strip slot (stack before this pane id). */
  before?: (tile: T) => null | string | undefined
  minWidth: string
  title: (key: string) => string
  /** Lead-dot color for the tile's tab (e.g. a session's project color). Re-read
   *  on every `also` change, so pass the color source in `also` to keep it live. */
  accent?: (key: string) => string | undefined
  /** Custom lead NODE for the tile's tab, rendered before the label. Unlike
   *  `accent` it is a SELF-SUBSCRIBING component (a session's status dot), so
   *  the strip needn't re-sync when status or colour move — only `title` drives
   *  re-registration. Wins over `accent` when both are given. */
  tabLead?: (key: string) => ReactNode
  render: (key: string) => ReactNode
  /** Glyph buttons the tile contributes to its zone's strip while it is the
   *  ACTIVE tile — e.g. a preview's source/rendered/diff switch. DATA, not
   *  markup: `PaneStripGlyph` owns the styling (see TileChrome.stripTools). */
  stripTools?: (key: string) => readonly PaneStripTool[]
  /** Wrap the tile's TAB (domain context menu — session verbs). */
  tabWrap?: (key: string, tab: ReactElement) => ReactNode
  /** Override the tile's TAB drag (session drop language: stack/split/link).
   *  Returns whether it took the drag (see PaneChrome.tabDrag). */
  tabDrag?: (
    key: string,
    event: ReactPointerEvent<HTMLElement>,
    onTap: () => void,
    double?: DoubleTapContext
  ) => boolean
  /** Wired as the pane's closer (tab Close). */
  close: (key: string) => void
}

/** Build a `watch*` fn: syncs once, then re-syncs on every source/also change.
 *  Module-level state lives in the returned closure, so call it once per app. */
export function paneMirror<T>(cfg: PaneMirror<T>): () => void {
  const registered = new Map<string, { dispose: () => void; title: string; accent?: string }>()
  const paneId = (key: string) => `${cfg.prefix}:${key}`

  /**
   * Spanned with a noise floor because this fires on every `also` change too —
   * a session rename, a project-colour edit — and is a no-op for tiles whose
   * title and accent are unchanged. What the span is really there to expose is
   * the FAN-OUT: each `registerTile` below invalidates the registry on its own,
   * so a sync that touches N tiles costs N adoption passes and N tree commits
   * rather than one, and `registered` is the number that shows it.
   */
  const sync = () => {
    const startedAt = isRecording() ? performance.now() : 0
    let registrations = 0
    let removals = 0

    const tiles = cfg.source.get()
    const wanted = new Set(tiles.map(cfg.key))

    for (const tile of tiles) {
      const key = cfg.key(tile)
      const title = cfg.title(key)
      const accent = cfg.accent?.(key)
      const current = registered.get(key)

      // register() replaces same-id in place — safe for live title/accent refreshes.
      if (current && current.title === title && current.accent === accent) {
        continue
      }

      const dispose = registerTile({
        id: paneId(key),
        kind: cfg.kind,
        title,
        placement: 'main',
        chrome: {
          accent,
          dock: {
            before: cfg.before?.(tile),
            pane: cfg.anchor?.(tile) ?? 'workspace',
            pos: cfg.dir?.(tile) ?? 'right'
          },
          // A mirrored tile is closeable and lives in the main stack, so it must
          // keep its strip even alone — otherwise the "3rd tile has no tab" trap
          // leaves it with nowhere to put the ✕.
          linkTarget: cfg.linkTarget,
          loneHeader: true,
          stripTools: cfg.stripTools ? () => cfg.stripTools!(key) : undefined,
          tabLead: cfg.tabLead ? () => cfg.tabLead!(key) : undefined,
          tabDrag: cfg.tabDrag
            ? (event: ReactPointerEvent<HTMLElement>, onTap: () => void, double?: DoubleTapContext) =>
                cfg.tabDrag!(key, event, onTap, double)
            : undefined, // returns boolean (handled) — see TileChrome.tabDrag
          tabWrap: cfg.tabWrap ? (tab: ReactElement) => cfg.tabWrap!(key, tab) : undefined
        },
        sizing: { minWidth: cfg.minWidth },
        onNewTab: cfg.onNewTab,
        render: () => cfg.render(key)
      })

      registered.set(key, { dispose, title, accent })
      registrations += 1

      if (!current) {
        registerPaneCloser(paneId(key), () => cfg.close(key))
      }
    }

    for (const [key, entry] of registered) {
      if (!wanted.has(key)) {
        entry.dispose()
        registered.delete(key)
        removeTreePane(paneId(key))
        removals += 1
      }
    }

    // Prune tree panes the SHARED tree persisted for a tile we never registered
    // this session and that isn't wanted now — a profile switch reloads with the
    // other profile's tile panes still stacked in. (`registered` is empty after a
    // reload, so the loop above can't catch these.)
    for (const id of treePanesWithPrefix(`${cfg.prefix}:`)) {
      if (!wanted.has(id.slice(cfg.prefix.length + 1))) {
        removeTreePane(id)
        removals += 1
      }
    }

    if (startedAt === 0) {
      return
    }

    const elapsed = performance.now() - startedAt

    if (elapsed >= SYNC_NOISE_FLOOR_MS || registrations > 0 || removals > 0) {
      recordSpan('layout.tiles.sync', startedAt, startedAt + elapsed, {
        kind: cfg.kind,
        registered: registrations,
        removed: removals,
        total: tiles.length
      })
    }
  }

  return () => {
    sync()
    cfg.source.listen(sync)
    cfg.also?.forEach(atom => atom.listen(sync))
  }
}
