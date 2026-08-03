import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Tauri event bus, reduced to what the module uses: `emit` broadcasts to every
// WebView (including the sender, which is why the payload carries an origin), and
// `listen` registers this WebView's receiver. Hoisted, because vi.mock's factory is
// lifted above ordinary top-level declarations.
const { emit, listen, listeners } = vi.hoisted(() => {
  const registered: Array<(event: { payload: unknown }) => void> = []

  return {
    emit: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
      registered.push(handler)

      return Promise.resolve(() => {})
    }),
    listeners: registered
  }
})

vi.mock('@tauri-apps/api/event', () => ({ emit, listen }))
// Without this the module short-circuits: there is no Tauri bus on plain web.
vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))
vi.mock('@/store/gateway-restore', () => ({ dialSavedTarget: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/gateway-soft-switch', () => ({ softSwitchGateway: vi.fn().mockResolvedValue(undefined) }))

import type { GatewayTarget } from '@/store/gateway-restore'
import { dialSavedTarget } from '@/store/gateway-restore'
import { softSwitchGateway } from '@/store/gateway-soft-switch'

import { broadcastGatewaySwitch, initGatewaySwitchSync } from './gateway-switch-sync'

const target = { mode: 'remote', url: 'new.gateway.test' } as GatewayTarget

/** Deliver an event the way Tauri would — to every registered listener. */
function deliver(payload: unknown): void {
  for (const handler of listeners) {
    handler({ payload })
  }
}

/** The origin stamped on this WebView's own broadcasts. */
function ownOrigin(): string {
  broadcastGatewaySwitch('remote', target)

  return (emit.mock.calls.at(-1)?.[1] as { origin: string }).origin
}

beforeEach(() => vi.clearAllMocks())

describe('gateway switch sync', () => {
  it('broadcasts the mode and target of a switch', () => {
    broadcastGatewaySwitch('cloud', target)

    expect(emit).toHaveBeenCalledOnce()
    const [name, payload] = emit.mock.calls[0]
    expect(name).toBe('gateway://switched')
    expect(payload).toMatchObject({ mode: 'cloud', target })
    expect((payload as { origin: string }).origin).toBeTruthy()
  })

  // `emit` is global, so this WebView receives its own broadcast. Re-homing on it
  // would tear down the connection the switch just established.
  it('ignores its own broadcast', () => {
    const origin = ownOrigin()
    vi.clearAllMocks()

    deliver({ origin, mode: 'cloud', target })

    expect(softSwitchGateway).not.toHaveBeenCalled()
  })

  it('re-homes onto the gateway another WebView switched to', async () => {
    deliver({ origin: 'some-other-webview', mode: 'cloud', target })

    expect(softSwitchGateway).toHaveBeenCalledOnce()
    const [mode, dial] = vi.mocked(softSwitchGateway).mock.calls[0]
    expect(mode).toBe('cloud')

    // The dial is the payload's target, not this WebView's saved one.
    await dial()
    expect(dialSavedTarget).toHaveBeenCalledWith(target)
  })

  it('ignores a malformed event rather than re-homing onto nothing', () => {
    deliver(null)
    deliver({ mode: 'cloud' })

    expect(softSwitchGateway).not.toHaveBeenCalled()
  })

  // main.tsx imports this module for its side effect; an extra init (HMR, a test)
  // must not stack receivers, or one switch would re-home this WebView N times.
  it('registers exactly one listener however many times it is initialised', () => {
    const before = listeners.length
    initGatewaySwitchSync()
    initGatewaySwitchSync()

    expect(listeners.length).toBe(before)
  })

  it('never lets a failed re-home reject into the event handler', async () => {
    vi.mocked(softSwitchGateway).mockRejectedValueOnce(new Error('follower dial failed'))

    expect(() => deliver({ origin: 'elsewhere', mode: 'remote', target })).not.toThrow()
    await Promise.resolve()
  })
})
