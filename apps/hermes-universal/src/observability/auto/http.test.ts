import { describe, expect, it } from 'vitest'

import { safeUrl } from './http'

/**
 * `safeUrl` is a privacy boundary, not a formatting helper: whatever it returns
 * can end up in a trace that gets shared or attached to a bug report. These
 * tests pin the things that must never survive it.
 */
describe('safeUrl', () => {
  it('drops the query string, which is where tokens and search terms live', () => {
    expect(safeUrl('https://gw.example.com/api/sessions?token=secret&q=hello')).toBe('/api/sessions')
  })

  it('drops the origin, which identifies a self-hosted gateway', () => {
    expect(safeUrl('https://someones-private-host.internal:8443/api/models')).toBe('/api/models')
  })

  it('drops the fragment', () => {
    expect(safeUrl('https://gw.example.com/api/x#frag')).toBe('/api/x')
  })

  it('keeps the path, which is what identifies the endpoint', () => {
    expect(safeUrl('https://gw.example.com/api/sessions/abc/messages')).toBe('/api/sessions/abc/messages')
  })

  it('still strips the query when the URL is relative and unparseable', () => {
    expect(safeUrl('/api/thing?token=secret')).toBe('/api/thing')
  })

  it('does not throw on junk', () => {
    expect(safeUrl('not a url at all')).toBe('not a url at all')
  })
})
