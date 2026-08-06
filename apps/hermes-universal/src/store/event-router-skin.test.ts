import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GatewayEvent } from '@/gateway'

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('@/store/atom')

  return {
    addGatewayEventListener: () => () => {},
    requestGateway: vi.fn().mockResolvedValue({}),
    $gatewayState: atom('idle')
  }
})

vi.mock('@/components/chat/vibe-hearts', () => ({ burstVibeHearts: vi.fn() }))

import { routeGatewayEvent } from '@/store/event-router'
import { $backendThemes, $pendingSkinApply, __resetBackendSkinSync } from '@/themes/backend-sync'

const skin = { name: 'neon', colors: { background: '#101020', ui_accent: '#ff33aa', ui_text: '#eeeeee' } }

const event = (type: string, payload: unknown): GatewayEvent => ({ type, payload }) as GatewayEvent

describe('event-router → skin watcher', () => {
  beforeEach(() => __resetBackendSkinSync())

  it('seeds the skin nested under gateway.ready without applying it', () => {
    routeGatewayEvent(event('gateway.ready', { skin, change_events: true }))

    expect($backendThemes.get().neon?.name).toBe('neon')
    // A fresh connect must never stomp the user's persisted theme.
    expect($pendingSkinApply.get()).toBeNull()
  })

  it('applies skin.changed, whose payload IS the skin', () => {
    routeGatewayEvent(event('skin.changed', skin))

    expect($pendingSkinApply.get()).toBe('neon')
  })

  it('tolerates a gateway.ready that carries no skin', () => {
    routeGatewayEvent(event('gateway.ready', { change_events: false }))
    routeGatewayEvent(event('gateway.ready', undefined))

    expect($backendThemes.get()).toEqual({})
    expect($pendingSkinApply.get()).toBeNull()
  })
})
