/**
 * How a tile contributes to its zone's SIZE.
 *
 * `TileSizing` became the single declaration in MJXHRM-165. What was still
 * scattered is the reading of it — three places asked the same two questions in
 * three shapes:
 *
 *   track-model `declared()`   sizing + px override → the zone's track length
 *   tree-split  `sizingFor()`  the shown tiles' clamps → the zone's min/max
 *   tree-split  sash drag      the shown tiles' declared length → px
 *
 * The first and third are the same question (`what length does this tile ask
 * for along this axis?`) asked once with the override and once without, which
 * is exactly the kind of near-duplicate that drifts. Both now go through
 * `tileAxisLength`.
 *
 * ── On the storage key ───────────────────────────────────────────────────────
 * The px overrides live in `store/panes.ts` (`hermes.paneStates.v1`), which the
 * legacy `pane-shell.tsx` grid also uses — it still renders the non-mobile
 * sub-768px web path. MJXHRM-169 proposed splitting the key so the two engines
 * stop sharing.
 *
 * They should NOT be split. The two engines overlap on `widthOverride` /
 * `heightOverride` only, and those mean the same thing in both: the pixel size
 * the user last dragged a NAMED pane to. Sharing them is the correct behaviour —
 * resize the file tree in one shell and the other agrees. The `open` flag is the
 * genuinely engine-specific field, and the tree never reads it (it resolves
 * reveal through `$hiddenTreePanes`). Splitting would have cost every user their
 * remembered sizes in exchange for nothing.
 */

import type { Tile, TileSizing } from './types'
import { tileSizing } from './types'

export type SizingAxis = 'row' | 'column'

/** The largest of the defined CSS lengths (deduped); `undefined` when none —
 *  the largest-tenant basis a fixed stack and its clamps both size from. */
export const cssMax = (values: (string | null | undefined)[]): string | undefined => {
  const unique = [...new Set(values.filter((v): v is string => Boolean(v)))]

  return unique.length === 0 ? undefined : unique.length === 1 ? unique[0] : `max(${unique.join(', ')})`
}

/**
 * The CSS length a tile asks for along `axis`, or null when it asks for none
 * (a flex-at-heart surface like the main chat).
 *
 * `override` is a live px size from a sash drag. It only REFINES a tile that
 * already declares a length on this axis: sash drags write overrides to fixed
 * zones only, so an override on a tile with no declaration is stale data from
 * another surface. Honouring it would turn a flex-at-heart zone (main!) into a
 * fixed track and hand the whole leftover to the run's absorber.
 */
export function tileAxisLength(tile: Tile | undefined, axis: SizingAxis, override?: number): string | null {
  const sizing = tileSizing(tile)
  const declared = (axis === 'row' ? sizing.width : sizing.height) ?? null

  return declared !== null && override !== undefined ? `${override}px` : declared
}

/**
 * A zone's clamps, aggregated across its shown tiles.
 *
 * Floors take the largest declared min; caps stay unbounded unless EVERY tile
 * declares one — a single uncapped tenant uncaps the zone. Same largest-tenant
 * basis as the track size, and never per-tab: switching tabs must not resize
 * the container.
 */
export function tileClamps(tiles: (Tile | undefined)[]): TileSizing {
  const all = tiles.map(tileSizing)
  const cap = (pick: (s: TileSizing) => string | undefined) => (all.every(pick) ? cssMax(all.map(pick)) : undefined)

  return {
    minWidth: cssMax(all.map(s => s.minWidth)),
    maxWidth: cap(s => s.maxWidth),
    minHeight: cssMax(all.map(s => s.minHeight)),
    maxHeight: cap(s => s.maxHeight)
  }
}
