import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({ api: vi.fn().mockResolvedValue({}) }))

import { api } from '@/lib/api'
import type { SessionInfo } from '@/types/hermes'

import {
  createWebhook,
  deleteWebhook,
  enableWebhooks,
  getAutomationBlueprints,
  getHermesConfig,
  getSession,
  getStatus,
  getWebhooks,
  instantiateAutomationBlueprint,
  listAllProfileSessions,
  listSessions,
  saveHermesConfig,
  setApiRequestProfile,
  setWebhookEnabled
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

// Ported from apps/desktop/src/webhooks-rest.test.ts. Two additions: the
// deliberate absence of a profile scope (none of the five backend handlers
// declares that query parameter, so sending one would advertise a scoping the
// client does not have), and the create payload's `secret`, which the backend
// accepts and desktop's client never offered.
describe('webhook REST', () => {
  // With a profile ACTIVE, so the assertion pins the absence rather than
  // agreeing with a `profileScoped()` that happened to be empty.
  it('getWebhooks → GET /api/webhooks, unscoped even under an active profile', async () => {
    setApiRequestProfile('work')

    try {
      await getWebhooks()
    } finally {
      setApiRequestProfile(null)
    }

    expect(mockApi).toHaveBeenCalledWith({ path: '/api/webhooks' })
  })

  it('enableWebhooks → POST /api/webhooks/enable', async () => {
    await enableWebhooks()

    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/api/webhooks/enable' }))
  })

  it('createWebhook → POST /api/webhooks with the full payload', async () => {
    const body = {
      deliver: 'telegram',
      deliver_chat_id: '-100123',
      deliver_only: true,
      description: 'push events',
      events: ['push'],
      name: 'github-push',
      prompt: 'summarize the push',
      secret: 'mine',
      skills: ['git']
    }

    await createWebhook(body)

    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ body, method: 'POST', path: '/api/webhooks' }))
  })

  // The name is a path segment; an unencoded one would address a different route
  // (or none), and DELETE addressing the wrong row is not a recoverable mistake.
  it('deleteWebhook encodes the name into the path', async () => {
    await deleteWebhook('my hook')

    expect(mockApi).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/api/webhooks/my%20hook' }))
  })

  it('setWebhookEnabled → PUT /api/webhooks/{name}/enabled, encoded, with the flag', async () => {
    await setWebhookEnabled('my hook', false)

    expect(mockApi).toHaveBeenCalledWith({
      body: { enabled: false },
      method: 'PUT',
      path: '/api/webhooks/my%20hook/enabled'
    })
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
