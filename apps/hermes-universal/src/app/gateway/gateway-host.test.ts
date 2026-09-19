import { describe, expect, it } from 'vitest'

import { gatewayHostOf } from './gateway-host'

describe('gatewayHostOf', () => {
  it('reads the host and port of a full URL', () => {
    expect(gatewayHostOf('https://xm.allr.work')).toBe('xm.allr.work')
    expect(gatewayHostOf('http://127.0.0.1:9119/hermes')).toBe('127.0.0.1:9119')
  })

  it('accepts a bare host', () => {
    expect(gatewayHostOf('gw.example.com/hermes')).toBe('gw.example.com')
  })

  it('has nothing to say about nothing', () => {
    expect(gatewayHostOf(undefined)).toBeNull()
    expect(gatewayHostOf('')).toBeNull()
  })
})
