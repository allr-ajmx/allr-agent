import { TILE_PANE_PREFIX } from '@/lib/pane-ids'

import type { Tile } from '../../tile/types'

/**
 * When a lone tile must keep its tab strip (name card + close).
 *
 * Default: a single tile isn't a "tab", so the header auto-hides. Exceptions
 * force it on:
 *  - session tiles (`session-tile:*`) — even before their tile registers
 *  - ANY `placement: 'main'` tile — incl. the uncloseable workspace, so the
 *    primary session ALWAYS shows its title tab like the tiles beside it
 *    (a lone workspace with no tab reads inconsistently next to titled tiles)
 *  - a collapse tool panel dragged into its own zone
 *
 * FIXME(MJXHRM-171): the `TILE_PANE_PREFIX` test is the last chat literal in
 * here. `TileChrome.loneHeader` already carries the same intent declaratively
 * (the pane mirror sets it on every tile it registers), so the de-literal step
 * deletes this branch. It stays for now only because step 1 must not change
 * behaviour — the prefix test fires for a session tile whose tile has not
 * registered yet, which `loneHeader` cannot do.
 */
export function forceLoneHeaderForPanes(
  shown: readonly string[],
  tileOf: (id: string) => Tile | undefined,
  isCollapsePane: (id: string) => boolean
): boolean {
  if (shown.some(id => id.startsWith(TILE_PANE_PREFIX))) {
    return true
  }

  if (shown.some(id => tileOf(id)?.placement === 'main')) {
    return true
  }

  return shown.length === 1 && isCollapsePane(shown[0])
}
