import { describe, expect, it } from 'vitest'

import { resolveTerminalWsUrl } from './gateway-config'

// The token/none paths are pure (no ticket mint), so they need no mocks.
describe('resolveTerminalWsUrl', () => {
  it('builds a token URL to /api/shell-pty with the cwd param', async () => {
    const url = await resolveTerminalWsUrl(
      { authMode: 'token', baseUrl: 'http://localhost:8788', token: 'abc' },
      { cwd: '/repo' }
    )

    expect(url).toContain('ws://localhost:8788/api/shell-pty')
    expect(url).toContain('cwd=%2Frepo')
    expect(url).toContain('token=abc')
  })

  it('omits auth for an ungated (none) backend and upgrades http→ws scheme', async () => {
    const url = await resolveTerminalWsUrl({ authMode: 'none', baseUrl: 'https://host.example' })
    expect(url).toBe('wss://host.example/api/shell-pty')
  })

  it('appends and url-encodes the attach reattach token when supplied', async () => {
    const url = await resolveTerminalWsUrl(
      { authMode: 'none', baseUrl: 'http://localhost:8788' },
      { attach: 'remote::http://gw:term-1' }
    )

    expect(url).toContain('attach=remote%3A%3Ahttp')
  })
})
