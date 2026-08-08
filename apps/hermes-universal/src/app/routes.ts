import { atom } from 'nanostores'
import type { ReactNode } from 'react'

import { registry } from '@/contrib/registry'
import type { Contribution } from '@/contrib/types'

export const SESSION_ROUTE_PREFIX = '/'
export const NEW_CHAT_ROUTE = '/'
export const SETTINGS_ROUTE = '/settings'
/** Settings drill-in for the gateway configurator — the phone's "Change gateway"
 *  target (the drawer popover is too cramped for the connect form). */
export const GATEWAY_SETTINGS_ROUTE = '/settings/gateway'
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

// ── Routes — the `routes` registry area ──────────────────────────────────────
// EVERY workspace page is a contribution: the app's own pages (Capabilities /
// Messaging / Artifacts, registered as `source: 'core'` in app/contrib/panes.tsx)
// and plugin pages alike, so the route table has exactly one shape. A plugin
// pairs a `render` with an absolute one-segment path. Contributed paths are
// reserved exactly like APP_ROUTES so the session-id parser below never mistakes
// `/kanban` for a session route. Navigate with `host.navigate(path)`.

export const ROUTES_AREA = 'routes'

/** Payload of a `routes` contribution's `data`. */
export interface RouteContribution {
  /** Absolute path, e.g. `/kanban`. One segment; no params. */
  path: string
}

export interface ResolvedRoute {
  key: string
  path: string
  render: () => ReactNode
  source: string
  title?: string
}

/** Validated pages, core + contributed. Pass the area's contributions when you
 *  already have them from a `useContributions(ROUTES_AREA)` subscription, so the
 *  React path derives from the same snapshot it re-rendered for. */
export function contributedRoutes(items: readonly Contribution[] = registry.getArea(ROUTES_AREA)): ResolvedRoute[] {
  return items
    .map(c => ({
      key: `${c.source ?? 'core'}:${c.id}`,
      path: (c.data as RouteContribution | undefined)?.path ?? '',
      render: c.render!,
      source: c.source ?? 'core',
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
        // Core registers the built-in pages AT their reserved paths (that's what
        // makes them routes); a plugin may not squat on one.
        (route.source === 'core' || !RESERVED_PATHS.has(route.path))
    )
}

/** A page that is NOT one of the app's own — i.e. a plugin page, which has no
 *  AppView of its own and classifies as `'extension'`. A core page keeps its
 *  APP_ROUTES view (`/skills` is `skills`, never `extension`). */
function isContributedPath(pathname: string): boolean {
  return !RESERVED_PATHS.has(pathname) && contributedRoutes().some(route => route.path === pathname)
}

// ── Sidebar nav — the `sidebar.nav` registry area ────────────────────────────
// The rail renders this area and nothing else: the built-in rows register as
// `source: 'core'` with negative `order` (app/shell/nav-contrib.ts), contributed
// rows land after them. Pair a plugin row with a ROUTES_AREA page — it navigates
// to `path` and lights up while the app is there.

export const SIDEBAR_NAV_AREA = 'sidebar.nav'

/** Payload of a `sidebar.nav` data contribution. */
export interface SidebarNavContribution {
  /** Codicon name, e.g. `'project'`. Defaults to `plug`. */
  codicon?: string
  /** Literal row label. Plugins set this; core rows use `labelKey` instead. */
  label?: string
  /** CORE ONLY: key into `t.sidebar.nav`, so the row follows the active locale. */
  labelKey?: string
  /** Route to navigate to (usually a contributed page's path). */
  path?: string
  /** CORE ONLY: an action row (e.g. New session) instead of / before navigating. */
  run?: () => void
  /** CORE ONLY: light the row up for this view rather than an exact path match —
   *  a session route still reads as `chat`, so New session stays lit. */
  view?: AppView
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

/** Does this route show a FULL PAGE (skills/messaging/artifacts) rather than the
 *  chat? Overlays (settings/command-center/…) don't count — the chat stays
 *  beneath them. Pure, so a caller can ask about a path without the atom below:
 *  only the desktop controller keeps that in sync, and the phone shell needs the
 *  same answer to decide whether its top-left button is a way out. */
export function isWorkspacePagePath(pathname: string): boolean {
  const view = appViewForPath(pathname)

  return view !== 'chat' && !isOverlayView(view)
}

/** The full page the workspace pane currently shows — its TITLE, which the
 *  workspace tile puts on its tab so the strip says "Capabilities" rather than
 *  the chat's name. `null` while the pane shows the chat. */
export const $workspacePage = atom<null | string>(null)

/** Tab title for a page path: the route contribution's own, else the path
 *  itself (a plugin page that registered no title still needs a tab label). */
function workspacePageTitle(pathname: string): string {
  return contributedRoutes().find(route => route.path === pathname)?.title || pathname.replace(/^\//, '')
}

export function syncWorkspacePage(pathname: string): void {
  const page = isWorkspacePagePath(pathname) ? workspacePageTitle(pathname) : null

  if (page !== $workspacePage.get()) {
    $workspacePage.set(page)
  }
}
