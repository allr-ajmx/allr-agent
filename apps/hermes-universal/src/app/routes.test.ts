import { afterEach, describe, expect, it } from 'vitest'

import { NAV_ITEMS } from '@/app/shell/nav-items'
import { registry } from '@/contrib/registry'
import { activitySurfaceForPath } from '@/store/windows'

import {
  appViewForPath,
  contributedRoutes,
  cronJobRoute,
  isOverlayView,
  isWorkspacePagePath,
  routeCronJobId,
  ROUTES_AREA,
  routeSessionId,
  sessionRoute,
  WEBHOOKS_ROUTE
} from './routes'

describe('routes', () => {
  it('maps reserved paths to their view, everything else to chat', () => {
    expect(appViewForPath('/settings')).toBe('settings')
    expect(appViewForPath('/agents')).toBe('agents')
    expect(appViewForPath('/')).toBe('chat')
    expect(appViewForPath('/abc123')).toBe('chat') // a session id
  })

  it('extracts a session id from a non-reserved single-segment path', () => {
    expect(routeSessionId('/abc123')).toBe('abc123')
    expect(routeSessionId('/settings')).toBeNull() // reserved
    expect(routeSessionId('/')).toBeNull()
    expect(routeSessionId('/a/b')).toBeNull() // multi-segment
  })

  it('round-trips sessionRoute ↔ routeSessionId with encoding', () => {
    const id = 'sess/with space'
    expect(routeSessionId(sessionRoute(id))).toBe(id)
  })

  it('flags overlay views', () => {
    expect(isOverlayView('settings')).toBe(true)
    expect(isOverlayView('chat')).toBe(false)
  })
})

// A new page is reachable only once every link in the chain agrees on it. The
// reservation is the link that fails SILENTLY: an unreserved `/webhooks` parses
// as a session id, so the route opens a phantom chat instead of the page.
describe('webhooks route registration', () => {
  it('resolves to the webhooks view and is reserved against the session parser', () => {
    expect(appViewForPath(WEBHOOKS_ROUTE)).toBe('webhooks')
    expect(routeSessionId(WEBHOOKS_ROUTE)).toBeNull()
  })

  it('is an overlay, not a workspace page — the chat stays beneath it', () => {
    expect(isOverlayView('webhooks')).toBe(true)
    expect(isWorkspacePagePath(WEBHOOKS_ROUTE)).toBe(false)
  })

  it('is a windowable surface, so Android opens it as a native screen', () => {
    expect(activitySurfaceForPath(WEBHOOKS_ROUTE)).toBe('webhooks')
  })

  it('is a destination the command menu registers', () => {
    expect(NAV_ITEMS.find(item => item.view === 'webhooks')?.path).toBe(WEBHOOKS_ROUTE)
  })
})

describe('cron deep link', () => {
  it('round-trips a job id through the route, encoded', () => {
    const id = 'job with/slash&amp'
    const route = cronJobRoute(id)

    expect(route.startsWith('/cron?job=')).toBe(true)
    expect(route).not.toContain('/slash')
    expect(routeCronJobId(new URL(route, 'http://x').search)).toBe(id)
  })

  // The path has to keep resolving to the cron view with the query on it, or the
  // deep link would open the wrong surface (and, on Android, the wrong activity).
  it('still resolves to the cron view — the id rides in the search, not the path', () => {
    expect(appViewForPath('/cron')).toBe('cron')
    expect(routeCronJobId('')).toBeNull()
    expect(routeCronJobId('?job=')).toBeNull()
    expect(routeCronJobId('?other=1')).toBeNull()
  })
})

const contribute = (path: string, id = 'demo:page') =>
  registry.register({ area: ROUTES_AREA, data: { path }, id, render: () => null, source: 'plugin:demo' })

describe('contributed routes', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    while (disposers.length) {
      disposers.pop()?.()
    }
  })

  it('accepts an absolute one-segment path', () => {
    disposers.push(contribute('/kanban'))

    expect(contributedRoutes().map(route => route.path)).toEqual(['/kanban'])
  })

  // The parser above treats any unreserved single segment as a session id, so a
  // contributed path MUST be reserved or `/kanban` opens a phantom session.
  it('reserves its path against the session-id parser', () => {
    expect(routeSessionId('/kanban')).toBe('kanban')

    disposers.push(contribute('/kanban'))

    expect(routeSessionId('/kanban')).toBeNull()
    expect(appViewForPath('/kanban')).toBe('extension')
  })

  it('rejects paths that would shadow the workspace catch-all or a core route', () => {
    disposers.push(
      contribute('kanban', 'demo:relative'),
      contribute('/*', 'demo:star'),
      contribute('/deep/page', 'demo:deep'),
      contribute('/users/:id', 'demo:param'),
      contribute('/settings', 'demo:core')
    )

    expect(contributedRoutes()).toEqual([])
  })

  it('rejects a contribution with no render fn', () => {
    disposers.push(
      registry.register({ area: ROUTES_AREA, data: { path: '/dataless' }, id: 'demo:norender', source: 'plugin:demo' })
    )

    expect(contributedRoutes()).toEqual([])
    // …and the path stays a session id, since it never became a real route.
    expect(routeSessionId('/dataless')).toBe('dataless')
  })

  it('stops reserving the path once the contribution is disposed', () => {
    const dispose = contribute('/kanban')

    expect(appViewForPath('/kanban')).toBe('extension')

    dispose()

    expect(appViewForPath('/kanban')).toBe('chat')
    expect(routeSessionId('/kanban')).toBe('kanban')
  })
})
