/**
 * The change watcher is the whole point of live-sync: if the router does not
 * demux its five broadcasts onto the right tick, every surface silently falls
 * back to polling and nothing is wrong except the battery.
 */

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
import {
  $changeEventsAvailable,
  $cronChangeTick,
  $pairingChangeTick,
  $petChange,
  $platformsChangeTick,
  $sessionsChangeTick,
  livePollIntervalMs,
  resetLiveSync
} from '@/store/live-sync'

const event = (type: string, payload?: unknown): GatewayEvent => ({ type, payload }) as GatewayEvent

beforeEach(() => {
  resetLiveSync()
  $cronChangeTick.set(0)
  $sessionsChangeTick.set(0)
  $platformsChangeTick.set(0)
  $pairingChangeTick.set(0)
  $petChange.set({ tick: 0 })
})

describe('change broadcasts → live-sync ticks', () => {
  it.each([
    ['cron.changed', $cronChangeTick],
    ['sessions.changed', $sessionsChangeTick],
    ['platforms.changed', $platformsChangeTick],
    ['pairing.changed', $pairingChangeTick]
  ])('%s bumps its own tick and no other', (type, tick) => {
    routeGatewayEvent(event(type, {}))

    expect(tick.get()).toBe(1)

    const others = [$cronChangeTick, $sessionsChangeTick, $platformsChangeTick, $pairingChangeTick].filter(
      other => other !== tick
    )

    expect(others.map(other => other.get())).toEqual([0, 0, 0])
  })

  it('routes the change events GLOBALLY — they carry no session and must not fail closed', () => {
    // The broadcaster builds its frame with an empty session id
    // (`_broadcast_global_event`), so an unknown-session drop would silence
    // every one of them.
    routeGatewayEvent({ type: 'cron.changed', payload: {}, session_id: '' } as GatewayEvent)

    expect($cronChangeTick.get()).toBe(1)
  })

  it('carries the pet payload through, since it decides whether to refetch the sheet', () => {
    routeGatewayEvent(event('pet.changed', { enabled: true, slug: 'cat', spritesheetRevision: 'r2' }))

    expect($petChange.get()).toEqual({
      tick: 1,
      meta: { enabled: true, slug: 'cat', spritesheetRevision: 'r2' }
    })
  })

  it('still bumps the pet tick on the enabled:false shape the watcher sends when there is no pet', () => {
    routeGatewayEvent(event('pet.changed', { enabled: false }))

    expect($petChange.get().tick).toBe(1)
    expect($petChange.get().meta?.enabled).toBe(false)
  })
})

describe('the change-events compat gate', () => {
  it('arms from gateway.ready and drops consumers onto their backstop', () => {
    expect(livePollIntervalMs(8_000, 60_000)).toBe(8_000)

    routeGatewayEvent(event('gateway.ready', { change_events: true }))

    expect($changeEventsAvailable.get()).toBe(true)
    expect(livePollIntervalMs(8_000, 60_000)).toBe(60_000)
  })

  it('keeps the legacy cadence against a gateway that does not advertise it', () => {
    routeGatewayEvent(event('gateway.ready', { change_events: true }))
    routeGatewayEvent(event('gateway.ready', {}))

    expect($changeEventsAvailable.get()).toBe(false)
    expect(livePollIntervalMs(8_000, 60_000)).toBe(8_000)
  })

  it('tolerates a gateway.ready with no payload at all', () => {
    routeGatewayEvent(event('gateway.ready'))

    expect($changeEventsAvailable.get()).toBe(false)
  })

  it('resets on a gateway wipe, so a stale true cannot strand consumers on the backstop', () => {
    routeGatewayEvent(event('gateway.ready', { change_events: true }))
    resetLiveSync()

    expect($changeEventsAvailable.get()).toBe(false)
  })
})
