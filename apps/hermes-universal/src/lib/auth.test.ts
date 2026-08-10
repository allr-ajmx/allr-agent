import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'

import { httpRequest } from '@/transport/http'

import { $oauthSession, mintWsTicket, oauthLogout, oauthStatus } from './auth'

const BASE = 'https://gw.example.com'

const ok = (ticket = 't1') => ({ status: 200, body: JSON.stringify({ ticket }), headers: {} })
const unauthorized = { status: 401, body: '', headers: {} }

function ticketHeaders(call: number): Record<string, string> {
  return (vi.mocked(httpRequest).mock.calls[call]?.[2] as { headers: Record<string, string> }).headers
}

beforeEach(() => {
  vi.clearAllMocks()
  $oauthSession.set(null)
})

// ── the mint carries no credential of its own (MJXHRM-354) ───────────────────

test('the mint sends no Authorization header, whichever session kind is live', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true, sessionKind: 'native' })
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await expect(mintWsTicket(BASE)).resolves.toBe('t1')
  // The bearer is attached by the Rust transport. A header built here could only
  // come from a token this process was handed — which is the whole bug.
  expect(ticketHeaders(0).Authorization).toBeUndefined()
  expect(ticketHeaders(0).Origin).toBe(BASE)
})

test('minting costs no oauth_status round trip at all', async () => {
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await mintWsTicket(BASE)
  await mintWsTicket(BASE)

  // The mint used to probe Rust for a bearer to paste on; it has nothing to ask.
  expect(vi.mocked(invoke)).not.toHaveBeenCalled()
})

test('a 401 surfaces as sign-in-again without a second attempt', async () => {
  vi.mocked(httpRequest).mockResolvedValue(unauthorized)

  await expect(mintWsTicket(BASE)).rejects.toThrow('Session expired')
  // Rust already rotated and retried behind this call; retrying here would only
  // repeat a request the gateway has twice refused.
  expect(vi.mocked(httpRequest)).toHaveBeenCalledTimes(1)
})

test('a non-401 failure names its status rather than blaming the session', async () => {
  vi.mocked(httpRequest).mockResolvedValue({ status: 503, body: '', headers: {} })

  await expect(mintWsTicket(BASE)).rejects.toThrow('HTTP 503')
})

test('a 200 with no ticket in it is an error, not an empty ticket', async () => {
  vi.mocked(httpRequest).mockResolvedValue({ status: 200, body: '{}', headers: {} })

  await expect(mintWsTicket(BASE)).rejects.toThrow('missing ticket')
})

// ── session kind (the only thing oauth_status hands back) ────────────────────

test('the status reply carries a session kind and no credential', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true, sessionKind: 'native', email: 'a@b.c' })

  const status = await oauthStatus(BASE)

  expect(status.sessionKind).toBe('native')
  expect(JSON.stringify(status)).not.toMatch(/token/i)
  expect($oauthSession.get()).toEqual({ base: BASE, kind: 'native' })
})

test('a trailing slash is the same gateway', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true, sessionKind: 'cookie' })

  await oauthStatus(`${BASE}/`)

  expect($oauthSession.get()).toEqual({ base: BASE, kind: 'cookie' })
})

test('a signed-out probe clears the session it spoke for', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ signedIn: true, sessionKind: 'native' })
  await oauthStatus(BASE)

  vi.mocked(invoke).mockResolvedValueOnce({ signedIn: false, sessionKind: null })
  await oauthStatus(BASE)

  expect($oauthSession.get()).toBeNull()
})

test('a signed-out probe of ANOTHER gateway leaves the live session alone', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ signedIn: true, sessionKind: 'native' })
  await oauthStatus(BASE)

  vi.mocked(invoke).mockResolvedValueOnce({ signedIn: false })
  await oauthStatus('https://other.example.com')

  expect($oauthSession.get()).toEqual({ base: BASE, kind: 'native' })
})

test('signing out drops the session kind before the round trip', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ signedIn: true, sessionKind: 'native' })
  await oauthStatus(BASE)

  vi.mocked(invoke).mockResolvedValueOnce(undefined)
  await oauthLogout(BASE)

  expect($oauthSession.get()).toBeNull()
})
