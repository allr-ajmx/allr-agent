import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))

import { httpRequest } from '@/transport/http'

import type { Connection } from './gateway-config'
import { forgetGatewayFeatures, gatewayFeatures } from './gateway-features'

const mockHttp = vi.mocked(httpRequest)

const ok = (body: unknown) => ({ body: JSON.stringify(body), headers: {}, status: 200 })

/** A distinct baseUrl per test so the module-level cache can't leak between them. */
let seq = 0

function conn(): Connection {
  seq += 1

  return { authMode: 'none', baseUrl: `http://gw-${seq}.test`, mode: 'remote' }
}

describe('gatewayFeatures', () => {
  beforeEach(() => {
    mockHttp.mockReset()
  })

  it('reads shell_pty from the health features map', async () => {
    mockHttp.mockResolvedValue(ok({ features: { shell_pty: true }, ok: true }))

    await expect(gatewayFeatures(conn())).resolves.toEqual({ shellPty: true, shellPtyReattach: false })
  })

  it('reads shell_pty_reattach alongside shell_pty', async () => {
    mockHttp.mockResolvedValue(ok({ features: { shell_pty: true, shell_pty_reattach: true }, ok: true }))

    await expect(gatewayFeatures(conn())).resolves.toEqual({ shellPty: true, shellPtyReattach: true })
  })

  it('treats a gateway with no features map as having no terminal API', async () => {
    // What every build older than the /api/shell-pty commit answers.
    mockHttp.mockResolvedValue(ok({ ok: true, version: '0.19.1' }))

    await expect(gatewayFeatures(conn())).resolves.toEqual({ shellPty: false, shellPtyReattach: false })
  })

  it('probes a backend once, then serves the cached answer', async () => {
    mockHttp.mockResolvedValue(ok({ features: { shell_pty: true } }))
    const c = conn()

    await gatewayFeatures(c)
    await gatewayFeatures(c)

    expect(mockHttp).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed probe, so a later attempt re-asks', async () => {
    mockHttp.mockResolvedValueOnce({ body: 'nope', headers: {}, status: 500 })
    const c = conn()

    await expect(gatewayFeatures(c)).resolves.toEqual({ shellPty: false, shellPtyReattach: false })

    mockHttp.mockResolvedValueOnce(ok({ features: { shell_pty: true } }))
    await expect(gatewayFeatures(c)).resolves.toEqual({ shellPty: true, shellPtyReattach: false })
    expect(mockHttp).toHaveBeenCalledTimes(2)
  })

  it('never rejects when the transport throws', async () => {
    mockHttp.mockRejectedValue(new Error('connection refused'))

    await expect(gatewayFeatures(conn())).resolves.toEqual({ shellPty: false, shellPtyReattach: false })
  })

  it('forgetGatewayFeatures drops the cached answer', async () => {
    mockHttp.mockResolvedValue(ok({ features: { shell_pty: false } }))
    const c = conn()

    await gatewayFeatures(c)
    forgetGatewayFeatures(c)
    await gatewayFeatures(c)

    expect(mockHttp).toHaveBeenCalledTimes(2)
  })
})
