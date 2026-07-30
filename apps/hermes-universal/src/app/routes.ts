import { atom } from 'nanostores'
import type { ReactNode } from 'react'

import { registry } from '@/contrib/registry'
import type { Contribution } from '@/contrib/types'

export const SESSION_ROUTE_PREFIX = '/'
export const NEW_CHAT_ROUTE = '/'
export const SETTINGS_ROUTE = '/settings'
/** Settings drill-in for the pet gallery + generator (`/hatch`, `/pet list`). */
export const PET_SETTINGS_ROUTE = '/settings/pet'
/** Settings drill-in for the plugin inventory (MJX-53). */
export const PLUGINS_SETTINGS_ROUTE = '/settings/plugins'
export const COMMAND_CENTER_ROUTE = '/command-center'
export const SKILLS_ROUTE = '/skills'
export const MESSAGING_ROUTE = '/messaging'
export const ARTIFACTS_ROUTE = '/artifacts'
export const CRON_ROUTE = '/cron'
export const PROFILES_ROUTE = '/profiles'
export const AGENTS_ROUTE = '/agents'
export const STARMAP_ROUTE = '/starmap'

export type AppView =
  | 'agents'
  | 'artifacts'
  | 'chat'
  | 'command-center'
  | 'cron'
  /** A contributed (plugin) page — see ROUTES_AREA below. */
  | 'extension'
  | 'messaging'
  | 'profiles'
  | 'settings'
  | 'skills'
  | 'starmap'

export type AppRouteId =
  | 'agents'
  | 'artifacts'
  | 'command-center'
  | 'cron'
  | 'messaging'
  | 'new'
  | 'profiles'
  | 'settings'
  | 'skills'
  | 'starmap'

export interface AppRoute {
  id: AppRouteId
  path: string
  view: AppView
}

export const APP_ROUTES = [
  { id: 'new', path: NEW_CHAT_ROUTE, view: 'chat' },
  { id: 'settings', path: SETTINGS_ROUTE, view: 'settings' },
  { id: 'command-center', path: COMMAND_CENTER_ROUTE, view: 'command-center' },
  { id: 'skills', path: SKILLS_ROUTE, view: 'skills' },
  { id: 'messaging', path: MESSAGING_ROUTE, view: 'messaging' },
  { id: 'artifacts', path: ARTIFACTS_ROUTE, view: 'artifacts' },
  { id: 'cron', path: CRON_ROUTE, view: 'cron' },
  { id: 'profiles', path: PROFILES_ROUTE, view: 'profiles' },
  { id: 'agents', path: AGENTS_ROUTE, view: 'agents' },
  { id: 'starmap', path: STARMAP_ROUTE, view: 'starmap' }
] as const satisfies readonly AppRoute[]

const APP_VIEW_BY_PATH = new Map<string, AppView>(APP_ROUTES.map(route => [route.path, route.view]))
const RESERVED_PATHS: ReadonlySet<string> = new Set(APP_ROUTES.map(route => route.path))

// ── Contributed routes — the `routes` registry area ──────────────────────────
// A plugin pairs a `render` with an absolute one-segment path and gets a real
// page inside the workspace pane (see app/contrib/panes.tsx). Contributed paths
// are reserved exactly like APP_ROUTES so the session-id parser below never
// mistakes `/kanban` for a session route. Navigate with `host.navigate(path)`.

export const ROUTES_AREA = 'routes'

/** Payload of a `routes` contribution's `data`. */
export interface RouteContribution {
  /** Absolute path, e.g. `/kanban`. One segment; no params. */
  path: string
}

/** Validated contributed pages. Pass the area's contributions when you already
 *  have them from a `useContributions(ROUTES_AREA)` subscription, so the React
 *  path derives from the same snapshot it re-rendered for. */
export function contributedRoutes(
  items: readonly Contribution[] = registry.getArea(ROUTES_AREA)
): Array<{ key: string; path: string; render: () => ReactNode; title?: string }> {
  return items
    .map(c => ({
      key: `${c.source ?? 'core'}:${c.id}`,
      path: (c.data as RouteContribution | undefined)?.path ?? '',
      render: c.render!,
      title: c.title
    }))
    .filter(
      route =>
        Boolean(route.render) &&
        route.path.startsWith('/') &&
        // One segment only. A `*`/`:param` path would shadow the workspace
        // route table's own catch-all and swallow every unmatched route.
        !route.path.slice(1).includes('/') &&
        !/[*:]/.test(route.path) &&
        !RESERVED_PATHS.has(route.path)
    )
}

function isContributedPath(pathname: string): boolean {
  return contributedRoutes().some(route => route.path === pathname)
}

// ── Contributed sidebar nav — the `sidebar.nav` registry area ────────────────
// A DATA contribution adds a row to the sidebar nav rail (below the built-ins).
// Pair with a ROUTES_AREA page: the row navigates to `path` and lights up while
// the app is there.

export const SIDEBAR_NAV_AREA = 'sidebar.nav'

/** Payload of a `sidebar.nav` data contribution. */
export interface SidebarNavContribution {
  /** Codicon name, e.g. `'project'`. Defaults to `plug`. */
  codicon?: string
  label: string
  /** Route to navigate to (usually a contributed page's path). */
  path: string
}

// Views that render as a full-screen modal card (OverlayView) over the shell.
// While one is open the app's titlebar control clusters must hide so they don't
// bleed over the overlay (they sit at a higher z-index than the overlay card).
export const OVERLAY_VIEWS: ReadonlySet<AppView> = new Set([
  'agents',
  'command-center',
  'cron',
  'profiles',
  'settings',
  'starmap'
])

export function isOverlayView(view: AppView): boolean {
  return OVERLAY_VIEWS.has(view)
}

export function isNewChatRoute(pathname: string): boolean {
  return pathname === NEW_CHAT_ROUTE
}

export function routeSessionId(pathname: string): string | null {
  if (!pathname.startsWith(SESSION_ROUTE_PREFIX) || RESERVED_PATHS.has(pathname) || isContributedPath(pathname)) {
    return null
  }

  const id = pathname.slice(SESSION_ROUTE_PREFIX.length)

  return id && !id.includes('/') ? decodeURIComponent(id) : null
}

export function sessionRoute(sessionId: string): string {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`
}

export function appViewForPath(pathname: string): AppView {
  if (isNewChatRoute(pathname) || routeSessionId(pathname)) {
    return 'chat'
  }

  if (isContributedPath(pathname)) {
    return 'extension'
  }

  return APP_VIEW_BY_PATH.get(pathname) ?? 'chat'
}

/** True while the workspace pane shows a FULL PAGE (skills/messaging/artifacts)
 *  instead of the chat. The workspace pane contribution mirrors it as
 *  `headerVeto` so the zone tab bar stands down on pages. Overlays
 *  (settings/command-center/…) don't count — the chat stays beneath them. */
export const $workspaceIsPage = atom(false)

export function syncWorkspaceIsPage(pathname: string): void {
  const view = appViewForPath(pathname)
  const isPage = view !== 'chat' && !isOverlayView(view)

  if (isPage !== $workspaceIsPage.get()) {
    $workspaceIsPage.set(isPage)
  }
}
