import { beforeEach, describe, expect, it } from 'vitest'

import { $gatewayMode, setGatewayMode } from './gateway-switch'

beforeEach(() => {
  localStorage.clear()
  $gatewayMode.set('remote')
})

describe('gateway-switch', () => {
  it('defaults to remote', () => {
    expect($gatewayMode.get()).toBe('remote')
  })

  it('persists the selected mode to localStorage without touching the connection', () => {
    setGatewayMode('local')
    expect($gatewayMode.get()).toBe('local')
    expect(localStorage.getItem('hermes.gateway.mode')).toBe('local')
  })
})
