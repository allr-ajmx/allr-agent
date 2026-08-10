import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/transport/http', () => ({ httpRequest: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'

import { httpRequest } from '@/transport/http'

import { forgetNativeBearer, mintWsTicket, oauthStatus } from './auth'

const BASE = 'https://gw.example.com'

const ok = (ticket = 't1') => ({ status: 200, body: JSON.stringify({ ticket }), headers: {} })
const unauthorized = { status: 401, body: '', headers: {} }

function ticketHeaders(call: number): Record<string, string> {
  return (vi.mocked(httpRequest).mock.calls[call]?.[2] as { headers: Record<string, string> }).headers
}

beforeEach(() => {
  vi.clearAllMocks()
  forgetNativeBearer(BASE)
})

test('a cookie gateway mints with no Authorization header', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true })
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await expect(mintWsTicket(BASE)).resolves.toBe('t1')
  expect(ticketHeaders(0).Authorization).toBeUndefined()
  expect(ticketHeaders(0).Origin).toBe(BASE)
})

test('a native session mints with its bearer', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true, nativeAccessToken: 'at-1' })
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await expect(mintWsTicket(BASE)).resolves.toBe('t1')
  expect(ticketHeaders(0).Authorization).toBe('Bearer at-1')
})

test('the bearer is resolved once and reused across mints', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true, nativeAccessToken: 'at-1' })
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await mintWsTicket(BASE)
  await mintWsTicket(BASE)

  // One oauth_status for the first mint; the reconnect costs no extra round trip.
  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
})

test('a bearer that expired between connect and mint is rotated and retried once', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({ signedIn: true, nativeAccessToken: 'stale' })
    .mockResolvedValueOnce({ signedIn: true, nativeAccessToken: 'fresh' })
  vi.mocked(httpRequest).mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(ok('t2'))

  await expect(mintWsTicket(BASE)).resolves.toBe('t2')
  expect(ticketHeaders(0).Authorization).toBe('Bearer stale')
  expect(ticketHeaders(1).Authorization).toBe('Bearer fresh')
})

test('a 401 that survives the rotation surfaces as sign-in-again', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({ signedIn: true, nativeAccessToken: 'stale' })
    .mockResolvedValueOnce({ signedIn: false, nativeAccessToken: null })
  vi.mocked(httpRequest).mockResolvedValue(unauthorized)

  await expect(mintWsTicket(BASE)).rejects.toThrow('Session expired')
  // Nothing to retry with, so the second attempt is never made.
  expect(vi.mocked(httpRequest)).toHaveBeenCalledTimes(1)
})

test('a cookie 401 is not retried — there is no bearer to rotate', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true })
  vi.mocked(httpRequest).mockResolvedValue(unauthorized)

  await expect(mintWsTicket(BASE)).rejects.toThrow('Session expired')
  expect(vi.mocked(httpRequest)).toHaveBeenCalledTimes(1)
})

test('an unreachable oauth_status degrades to the cookie path instead of failing the mint', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('no tauri host'))
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await expect(mintWsTicket(BASE)).resolves.toBe('t1')
  expect(ticketHeaders(0).Authorization).toBeUndefined()
})

test('oauthStatus caches the bearer it observed for the mint', async () => {
  vi.mocked(invoke).mockResolvedValue({ signedIn: true, nativeAccessToken: 'at-9' })
  vi.mocked(httpRequest).mockResolvedValue(ok())

  await oauthStatus(BASE)
  // A trailing slash is the same gateway — the cache must not miss on it.
  await mintWsTicket(`${BASE}/`)

  expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
  expect(ticketHeaders(0).Authorization).toBe('Bearer at-9')
})
