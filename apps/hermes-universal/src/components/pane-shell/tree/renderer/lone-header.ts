import { TILE_PANE_PREFIX } from '@/lib/pane-ids'
/**
 * When a lone pane must keep its tab strip (name card + close).
 *
 * Default: a single pane isn't a "tab", so the header auto-hides. Exceptions
 * force it on:
 *  - session tiles (`session-tile:*`) — even before chrome registers
 *  - ANY `placement: 'main'` contribution — incl. the uncloseable workspace, so
 *    the primary session ALWAYS shows its title tab like the tiles beside it
 *    (a lone workspace with no tab reads inconsistently next to titled tiles)
 *  - a collapse tool panel dragged into its own zone
 */

export interface LoneHeaderChrome {
  placement?: string
  uncloseable?: boolean
}

export function forceLoneHeaderForPanes(
  shown: readonly string[],
  chromeOf: (id: string) => LoneHeaderChrome,
  isCollapsePane: (id: string) => boolean
): boolean {
  if (shown.some(id => id.startsWith(TILE_PANE_PREFIX))) {
    return true
  }

  if (shown.some(id => chromeOf(id).placement === 'main')) {
    return true
  }

  return shown.length === 1 && isCollapsePane(shown[0])
}
