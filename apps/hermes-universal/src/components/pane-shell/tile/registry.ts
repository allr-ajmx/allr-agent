/**
 * The tile registry — a typed facade over the contribution registry's `panes`
 * area.
 *
 * Tiles ride the SAME `Contribution` transport they always did, so ordering,
 * provenance (`source`), plugin loading, `when`/`enabled` resolution and
 * area-scoped invalidation all keep working untouched. What changes is that the
 * `data: unknown` payload is now written and read in exactly ONE place — here.
 * Every consumer downstream gets a `Tile`.
 *
 * This is the whole point of the module: the unchecked `as PaneChrome` /
 * `as PaneSizing` / `as { uncloseable?: boolean }` reads scattered across the
 * renderer and the store collapse into `toTile` below, which ADAPTS both payload
 * shapes — the structured one `registerTile` writes, and the flat one the
 * published plugin SDK still accepts.
 */

import { useMemo } from 'react'

import { useContributions } from '@/contrib/react/use-contributions'
import { registry } from '@/contrib/registry'
import type { Contribution } from '@/contrib/types'

import type { Tile, TileChrome, TileId, TileLifecycle, TilePlacement, TileSizing } from './types'

export const PANES_AREA = 'panes'

/**
 * What a tile puts in `Contribution.data`. Declared, so a registration site
 * that invents a key stops type-checking — the failure this whole module
 * exists to produce. (`dock` and `revealOnPreset` were exactly that: passed by
 * the controller for months, declared by nothing.)
 */
interface TilePayload {
  kind: string
  placement?: TilePlacement
  chrome?: TileChrome
  sizing?: TileSizing
  lifecycle?: TileLifecycle
  onNewTab?: () => void
}

const isTilePayload = (data: unknown): data is TilePayload =>
  typeof data === 'object' && data !== null && typeof (data as TilePayload).kind === 'string'

/**
 * The FLAT payload shape — chrome keys and sizing keys side by side in one
 * blob, which is what every pane contribution looked like before this module,
 * and what the plugin SDK's published contract still is:
 *
 *     ctx.register({ area: PANES_AREA, id, render, data: { placement: 'right', width: '20rem' } })
 *
 * Plugins are an EXTERNAL contract — a third-party plugin compiled against the
 * shipped SDK cannot be migrated by editing this repo — so the flat shape has
 * to keep working. `toTile` normalizes it into the structured one, which is why
 * this module is an adapter rather than a validator that rejects.
 */
type FlatPayload = TileChrome & TileSizing & { placement?: TilePlacement }

const CHROME_KEYS = [
  'collapsible',
  'uncloseable',
  'headerVeto',
  'revealOnPreset',
  'revealAliases',
  'accent',
  'dock',
  'anchor',
  'tabWrap',
  'tabDrag',
  'loneHeader'
] as const satisfies readonly (keyof TileChrome)[]

const SIZING_KEYS = [
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight'
] as const satisfies readonly (keyof TileSizing)[]

const pick = <T extends object, K extends readonly (keyof T)[]>(source: T, keys: K): Partial<Pick<T, K[number]>> => {
  const out: Partial<Pick<T, K[number]>> = {}

  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key]
    }
  }

  return out
}

/**
 * Read a contribution as a tile — the ONE place `Contribution.data` is
 * interpreted. `undefined` when the contribution can't be one.
 *
 * A tile MUST be able to render: the tree resolves a leaf to content, and a
 * leaf that renders nothing is a hole in the layout, not a tile.
 */
export function toTile(contribution: Contribution | undefined): Tile | undefined {
  if (!contribution?.render) {
    return undefined
  }

  const payload = readPayload(contribution)

  return {
    chrome: payload.chrome,
    id: contribution.id,
    kind: payload.kind,
    lifecycle: payload.lifecycle,
    onNewTab: payload.onNewTab,
    order: contribution.order,
    placement: payload.placement,
    render: contribution.render,
    sizing: payload.sizing,
    source: contribution.source,
    // Truthiness, not `??`: a tile whose title resolved to '' (a session whose
    // name hasn't streamed in yet) would render an invisible tab with nothing
    // to click. The id is ugly but always present.
    title: contribution.title || contribution.id
  }
}

function readPayload(contribution: Contribution): TilePayload {
  const data = contribution.data

  if (isTilePayload(data)) {
    return data
  }

  // Flat (plugin / pre-tile) shape. `kind` is derived rather than invented: a
  // plugin pane's provenance already names it, and the engine must never branch
  // on kind anyway — it is descriptive, not behavioural.
  const flat: FlatPayload = typeof data === 'object' && data !== null ? (data as FlatPayload) : {}
  const chrome = pick(flat, CHROME_KEYS)
  const sizing = pick(flat, SIZING_KEYS)

  return {
    chrome: Object.keys(chrome).length ? chrome : undefined,
    kind: contribution.source && contribution.source !== 'core' ? contribution.source : 'pane',
    placement: flat.placement,
    sizing: Object.keys(sizing).length ? sizing : undefined
  }
}

/** A tile as the contribution that carries it. Exported for the plugin context,
 *  which must namespace the id and tag provenance before it reaches the
 *  registry — so it needs the mapping without the registration. */
export const toTileContribution = (tile: Tile): Contribution => ({
  area: PANES_AREA,
  data: {
    chrome: tile.chrome,
    kind: tile.kind,
    lifecycle: tile.lifecycle,
    onNewTab: tile.onNewTab,
    placement: tile.placement,
    sizing: tile.sizing
  } satisfies TilePayload,
  id: tile.id,
  order: tile.order,
  render: tile.render,
  source: tile.source,
  title: tile.title
})

/** Register one tile. Returns a disposer. Re-registering an id replaces it in
 *  place — that is how live retitling (`syncWorkspaceTitle`) works without
 *  remounting the content. */
export const registerTile = (tile: Tile): (() => void) => registry.register(toTileContribution(tile))

/** Register several at once — one invalidation for the batch, not one per tile. */
export const registerTiles = (tiles: Tile[]): (() => void) => registry.registerMany(tiles.map(toTileContribution))

/** Every registered tile, in resolved order. Imperative — for stores and
 *  engines outside React. The array identity is stable until the area mutates,
 *  so it is safe as a memo dep. */
export function getTiles(): readonly Tile[] {
  return resolve(registry.getArea(PANES_AREA))
}

/** One tile by id, or `undefined` when it isn't registered (a plugin that
 *  hasn't loaded, a session tile whose session closed). */
export function findTile(id: TileId): Tile | undefined {
  return tileMap().get(id)
}

/**
 * Every registered tile, KEYED BY ID.
 *
 * The engine resolves ids to tiles constantly — once per pane per predicate,
 * several times per pane per render, and inside `node.panes.some(...)` walks
 * that are themselves inside a walk of every zone. Each of those was a linear
 * scan of the whole tile set, i.e. O(tiles) nested in O(panes).
 *
 * It costs nothing to fix because the invalidation point already exists: the
 * map is built by the same `resolve()` that memoizes the array, on the same
 * registry-snapshot identity. A tile set that hasn't mutated returns the same
 * Map, so this is also safe as a memo/effect dependency.
 */
export function tileMap(): ReadonlyMap<TileId, Tile> {
  resolve(registry.getArea(PANES_AREA))

  return cachedById
}

/** `tileMap` for React, subscribed to the tile set. Same stability contract as
 *  `useTiles` — a new identity only when the area actually mutates. */
export function useTileMap(): ReadonlyMap<TileId, Tile> {
  const contributions = useContributions(PANES_AREA)

  return useMemo(() => {
    resolve(contributions)

    return cachedById
  }, [contributions])
}

/** Subscribe a React tree to the tile set. Memoized on the registry snapshot's
 *  identity — `getArea` returns the same array until the area mutates — so the
 *  result stays referentially stable between mutations and is safe as a memo
 *  dep or an effect dependency. */
export function useTiles(): readonly Tile[] {
  const contributions = useContributions(PANES_AREA)

  return useMemo(() => resolve(contributions), [contributions])
}

/** Cache the mapped array per snapshot so `getTiles()` — called from stores on
 *  every tree commit — doesn't rebuild the list on each read. The id map rides
 *  the same cache: one pass builds both, and they invalidate together. */
let cachedFrom: readonly Contribution[] | null = null
let cachedTiles: readonly Tile[] = []
let cachedById: ReadonlyMap<TileId, Tile> = new Map()

function resolve(contributions: readonly Contribution[]): readonly Tile[] {
  if (cachedFrom === contributions) {
    return cachedTiles
  }

  cachedFrom = contributions
  cachedTiles = contributions.map(toTile).filter((tile): tile is Tile => tile !== undefined)
  cachedById = new Map(cachedTiles.map(tile => [tile.id, tile]))

  return cachedTiles
}
