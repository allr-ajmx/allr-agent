import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: vi.fn().mockResolvedValue({}) }))

import { api } from '@/lib/api'
import type { SessionInfo } from '@/types/hermes'

import {
  getAutomationBlueprints,
  getHermesConfig,
  getSession,
  getStatus,
  instantiateAutomationBlueprint,
  listAllProfileSessions,
  listSessions,
  saveHermesConfig
} from './hermes'

const mockApi = vi.mocked(api)

afterEach(() => mockApi.mockClear())

// Light coverage that the whole-file port kept each function wired to the right
// request through the mobile api() seam.
describe('hermes REST client', () => {
  it('getStatus → GET /api/status', async () => {
    await getStatus()
    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/status' }))
  })

  it('getSession(id) → /api/sessions/{id}', async () => {
    await getSession('abc')
    expect(mockApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('/api/sessions/abc') })
    )
  })

  it('getHermesConfig → /api/config', async () => {
    await getHermesConfig()
    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/config' }))
  })

  it('saveHermesConfig → PUT /api/config with a body', async () => {
    await saveHermesConfig({ x: 1 })
    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/config', method: 'PUT' }))
  })
})

// The catalog GET is global; instantiate names the profile it WRITES the job to
// (the backend defaults that query param to "default", which is not the same as
// the caller's active profile) — so the two calls must not be symmetrical.
describe('automation blueprints', () => {
  it('getAutomationBlueprints → GET /api/cron/blueprints, unscoped', async () => {
    mockApi.mockResolvedValueOnce({ blueprints: [] })
    await getAutomationBlueprints()

    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/cron/blueprints' }))
  })

  it('instantiateAutomationBlueprint → POST with the blueprint key, values and target profile', async () => {
    await instantiateAutomationBlueprint({ blueprint: 'daily-brief', values: { time: '08:00' } }, 'work')

    expect(mockApi).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { blueprint: 'daily-brief', values: { time: '08:00' } },
        method: 'POST',
        path: '/api/cron/blueprints/instantiate?profile=work'
      })
    )
  })

  it('encodes a profile name that needs it', async () => {
    await instantiateAutomationBlueprint({ blueprint: 'x', values: {} }, 'my profile')

    expect(mockApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/cron/blueprints/instantiate?profile=my%20profile' })
    )
  })
})

// Both list endpoints send include_pinned=True, which back-fills pinned rows
// PAST the LIMIT and appends them after the recency window. The client's job is
// to keep its page window without throwing those rows away again.
describe('session list paging keeps back-filled pins', () => {
  const row = (id: string, pinned = false) => ({ id, pinned }) as unknown as SessionInfo

  const page = (sessions: SessionInfo[]) => ({ sessions, total: 99, limit: 2, offset: 0 })

  it('keeps a pinned row the backend appended past the limit', async () => {
    mockApi.mockResolvedValueOnce(page([row('a'), row('b'), row('old-pin', true)]))

    const result = await listSessions(2)

    expect(result.sessions.map(s => s.id)).toEqual(['a', 'b', 'old-pin'])
  })

  it('still drops an unpinned row past the limit — that one really is overflow', async () => {
    mockApi.mockResolvedValueOnce(page([row('a'), row('b'), row('c'), row('old-pin', true)]))

    const result = await listSessions(2)

    expect(result.sessions.map(s => s.id)).toEqual(['a', 'b', 'old-pin'])
  })

  it('leaves a short page untouched', async () => {
    mockApi.mockResolvedValueOnce(page([row('a')]))

    await expect(listSessions(2).then(r => r.sessions.map(s => s.id))).resolves.toEqual(['a'])
  })

  it('applies the same window to the cross-profile aggregator', async () => {
    mockApi.mockResolvedValueOnce(page([row('a'), row('b'), row('c'), row('old-pin', true)]))

    const result = await listAllProfileSessions(2)

    expect(result.sessions.map(s => s.id)).toEqual(['a', 'b', 'old-pin'])
  })
})
