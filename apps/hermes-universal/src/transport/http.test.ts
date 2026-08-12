import { describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { bytesToBase64, getJson, urlForError } from './http'

describe('bytesToBase64', () => {
  it('round-trips through atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]).buffer

    expect(atob(bytesToBase64(bytes))).toBe(String.fromCharCode(0, 1, 2, 250, 255))
  })

  // `String.fromCharCode(...view)` blows the argument limit here and throws,
  // which is why the encoder chunks.
  it('encodes a payload past the spread-argument limit', () => {
    const big = new Uint8Array(300_000).fill(7)

    expect(bytesToBase64(big.buffer)).toBe(btoa(String.fromCharCode(7).repeat(300_000)))
  })

  it('encodes nothing as the empty string', () => {
    expect(bytesToBase64(new Uint8Array(0).buffer)).toBe('')
  })
})

describe('urlForError', () => {
  // A gateway ws/REST URL's query IS the credential — `?token=` (local/SSH) or a
  // per-connect `?ticket=` — and `getJson` puts this string into an Error the UI
  // renders. The host and path are what diagnose the failure; the query is not.
  it('drops the query a credential rides in', () => {
    expect(urlForError('https://gw.example.com/api/status?ticket=s3cr3t-ws-ticket')).toBe(
      'https://gw.example.com/api/status'
    )
    expect(urlForError('http://127.0.0.1:5051/api/ws?token=s3cr3t&profile=work')).toBe('http://127.0.0.1:5051/api/ws')
  })

  it('leaves a query-free url exactly as it was', () => {
    expect(urlForError('https://gw.example.com/api/status')).toBe('https://gw.example.com/api/status')
  })
})

describe('getJson', () => {
  // The seam, not just the helper: a non-2xx raises an Error whose message the
  // UI renders, and the URL it names is a gateway URL whose query is the
  // credential. Pinned here because `urlForError` being correct says nothing
  // about this call site using it.
  it('never names the credential in the error it throws', async () => {
    invokeMock.mockResolvedValueOnce({ status: 401, headers: {}, body: 'unauthorized' })

    await expect(getJson('https://gw.example.com/api/status?ticket=s3cr3t-ws-ticket')).rejects.toThrow(
      /GET https:\/\/gw\.example\.com\/api\/status → HTTP 401/
    )

    invokeMock.mockResolvedValueOnce({ status: 401, headers: {}, body: 'unauthorized' })

    await expect(getJson('https://gw.example.com/api/status?ticket=s3cr3t-ws-ticket')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('s3cr3t-ws-ticket') })
    )
  })
})
