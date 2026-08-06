import type { Tile } from '../../tile/types'

/**
 * When a lone tile must keep its tab strip (name card + close).
 *
 * Default: a single tile isn't a "tab", so the header auto-hides. Exceptions
 * force it on:
 *  - a tile that DECLARES `chrome.loneHeader` — a closeable tile in the main
 *    stack needs somewhere to put its ✕, else a tile alone in its own zone is
 *    unclosable (the "3rd tile has no tab" trap);
 *  - ANY `placement: 'main'` tile — incl. the uncloseable workspace, so the
 *    primary session ALWAYS shows its title tab like the tiles beside it (a
 *    lone workspace with no tab reads inconsistently next to titled tiles);
 *  - a tool panel dragged into its own zone.
 *
 * The first rule used to be `id.startsWith('session-tile:')` — the layout
 * engine reading a chat id prefix to decide chrome. The pane mirror now sets
 * `loneHeader` on every tile it registers, which says the same thing without
 * the engine knowing what a session is.
 */
export function forceLoneHeaderForPanes(
  shown: readonly string[],
  tileOf: (id: string) => Tile | undefined,
  isCollapsePane: (id: string) => boolean
): boolean {
  if (shown.some(id => tileOf(id)?.chrome?.loneHeader)) {
    return true
  }

  if (shown.some(id => tileOf(id)?.placement === 'main')) {
    return true
  }

  return shown.length === 1 && isCollapsePane(shown[0])
}
