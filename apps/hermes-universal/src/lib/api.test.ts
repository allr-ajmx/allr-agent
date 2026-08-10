import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))

import { $connection } from '@/store/connection'
import { httpRequest } from '@/transport/http'

import { api } from './api'

const mockHttp = vi.mocked(httpRequest)

afterEach(() => {
  mockHttp.mockReset()
  $connection.set(null)
})

describe('api', () => {
  it('throws when not connected', async () => {
    await expect(api({ path: '/api/status' })).rejects.toThrow('Not connected')
  })

  it('joins base+path, attaches the session token, parses JSON', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'token', token: 'TOK' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) })

    const res = await api<{ ok: boolean }>({ path: '/api/status' })

    expect(res).toEqual({ ok: true })
    expect(mockHttp).toHaveBeenCalledWith(
      'GET',
      'http://host:1/api/status',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Hermes-Session-Token': 'TOK' }) })
    )
  })

  it('appends ?profile= when a non-default profile is set', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: '{}' })

    await api({ path: '/api/skills', profile: 'work' })
    expect(mockHttp).toHaveBeenCalledWith('GET', 'http://host:1/api/skills?profile=work', expect.anything())
  })

  it('merges ?profile= into a path that already has a query', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: '{}' })

    await api({ path: '/api/model/options?refresh=1', profile: 'work' })
    expect(mockHttp).toHaveBeenCalledWith(
      'GET',
      'http://host:1/api/model/options?refresh=1&profile=work',
      expect.anything()
    )
  })

  it('omits ?profile= for the default profile (null/current)', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: '{}' })

    await api({ path: '/api/skills', profile: 'current' })
    await api({ path: '/api/skills', profile: null })
    expect(mockHttp).toHaveBeenCalledWith('GET', 'http://host:1/api/skills', expect.anything())
    expect(mockHttp).not.toHaveBeenCalledWith('GET', expect.stringContaining('profile='), expect.anything())
  })

  it('sets Content-Type on a body and throws on a non-2xx status', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 500, headers: {}, body: 'boom' })

    await expect(api({ path: '/x', method: 'POST', body: { a: 1 } })).rejects.toThrow('HTTP 500')
    expect(mockHttp).toHaveBeenCalledWith(
      'POST',
      'http://host:1/x',
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) })
    )
  })
})

describe('api uploads', () => {
  const upload = { filename: 'shot.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]).buffer }

  it('forwards a multipart upload to the transport', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: '{}' })

    await api({ path: '/api/plugins/kanban/attachments', method: 'POST', upload })

    expect(mockHttp).toHaveBeenCalledWith(
      'POST',
      'http://host:1/api/plugins/kanban/attachments',
      expect.objectContaining({ upload })
    )
  })

  // reqwest generates the boundary, so ours would name one the body never uses.
  it('does not set a JSON Content-Type on an upload', async () => {
    $connection.set({ baseUrl: 'http://host:1', authMode: 'none' })
    mockHttp.mockResolvedValue({ status: 200, headers: {}, body: '{}' })

    await api({ path: '/api/plugins/kanban/attachments', method: 'POST', body: { note: 'x' }, upload })

    const opts = mockHttp.mock.calls[0][2] as { headers: Record<string, string> }
    expect(opts.headers['Content-Type']).toBeUndefined()
  })
})
