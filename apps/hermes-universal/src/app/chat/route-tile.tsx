/**
 * ROUTE (PAGE) TILES — a full-page view rendered as a layout-tree pane BESIDE
 * the main thread, the page analog of session tiles. Lifecycle mirrors session
 * tiles: `openRouteTile(path)` -> `watchRouteTiles` registers a pane docked
 * beside main -> tree adoption lands it on the chosen edge; closing removes it.
 *
 * Universal difference from desktop's `app/chat/route-tile.tsx`: desktop keeps a
 * `BUILTIN_PAGES` map beside the contributed ones because its built-in pages
 * aren't contributions. Here every page IS a `routes` contribution (MJX-52), so
 * a tile resolves Capabilities and a plugin page through the same lookup.
 */

import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { $routeTiles, closeRouteTile, type RouteTile } from '@/store/route-tiles'

import { contributedRoutes, ROUTES_AREA } from '../routes'

import { paneMirror } from './pane-mirror'

/** Humanize a route path into a tab title: `/my-atlas` → `My Atlas`. */
const humanizePath = (path: string): string =>
  path
    .replace(/^\/+/, '')
    .split(/[/-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || path

/** Title for a route tile: the page's own `title`, else a humanized path —
 *  never the internal `${source}:${id}` key. */
function routeTitle(path: string): string {
  return contributedRoutes().find(route => route.path === path)?.title ?? humanizePath(path)
}

function RouteTilePane({ path }: { path: string }) {
  // Subscribe so a plugin page tile appears the moment its route registers.
  const contributions = useContributions(ROUTES_AREA)
  const page = contributedRoutes(contributions).find(route => route.path === path)

  if (!page) {
    return (
      <div className="grid h-full place-items-center font-mono text-[11px] text-(--ui-text-quaternary)">
        no page at {path}
      </div>
    )
  }

  return (
    <ContribBoundary id={path}>
      <ContribRender render={page.render} />
    </ContribBoundary>
  )
}

// ---------------------------------------------------------------------------
// Route tile -> pane contribution sync (call once from the app root).
// ---------------------------------------------------------------------------

/** Keep pane contributions mirroring `$routeTiles`. Call once from the root. */
export const watchRouteTiles = paneMirror<RouteTile>({
  close: closeRouteTile,
  dir: tile => tile.dir,
  key: tile => tile.path,
  minWidth: '22rem',
  prefix: 'route-tile',
  render: path => <RouteTilePane path={path} />,
  source: $routeTiles,
  title: routeTitle
})
