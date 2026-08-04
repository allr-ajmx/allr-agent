import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import {
  appViewForPath,
  contributedRoutes,
  isOverlayView,
  ROUTES_AREA,
  routeSessionId,
  sessionRoute
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
