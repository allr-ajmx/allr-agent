import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => undefined),
  listen: vi.fn<(topic: string, cb: (event: { payload: unknown }) => void) => Promise<() => void>>(
    async () => () => undefined
  )
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))

import { createNativeLease } from './native-engine'

const TARGET = { target: { baseUrl: 'http://gw', headers: { 'X-Hermes-Session-Token': 't' } } }

describe('native voice lease handshake', () => {
  beforeEach(() => {
    invoke.mockClear()
    listen.mockClear()
    invoke.mockImplementation(async () => undefined)
    listen.mockImplementation(async () => () => undefined)
  })

  it('subscribes to all seven topics before invoking voice_open', async () => {
    let listensAtOpen = -1
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'voice_open') {
        listensAtOpen = listen.mock.calls.length
      }

      return undefined
    })

    const lease = createNativeLease()
    await lease.init(TARGET)

    const topics = listen.mock.calls.map(call => String(call[0]))
    expect(topics).toHaveLength(7)

    for (const suffix of ['state', 'level', 'speechStart', 'transcript', 'turnEmpty', 'idleTimeout', 'error']) {
      expect(topics.some(topic => topic.endsWith(`/${suffix}`))).toBe(true)
    }

    // All subscriptions were live before the device was opened.
    expect(listensAtOpen).toBe(7)
    expect(invoke).toHaveBeenCalledWith('voice_open', expect.objectContaining({ id: expect.any(String) }))
  })

  it('decodes payloads into typed events', async () => {
    const subscribed: Record<string, (payload: unknown) => void> = {}
    listen.mockImplementation(async (topic: string, cb: (event: { payload: unknown }) => void) => {
      const suffix = topic.split('/').pop() as string
      subscribed[suffix] = payload => cb({ payload })

      return () => undefined
    })

    const lease = createNativeLease()
    const events: unknown[] = []
    lease.on(event => events.push(event))
    await lease.init(TARGET)

    subscribed.state('recording')
    subscribed.level(0.42)
    subscribed.transcript({ text: 'hello', provider: 'groq', durationMs: 1200 })
    subscribed.turnEmpty({ reason: 'noSpeech' })

    expect(events).toEqual([
      { type: 'state', state: 'recording' },
      { type: 'level', level: 0.42 },
      { type: 'transcript', text: 'hello', provider: 'groq', durationMs: 1200 },
      { type: 'turnEmpty', reason: 'noSpeech' }
    ])
  })

  it('a close requested during init closes instead of opening', async () => {
    const lease = createNativeLease()
    const initPromise = lease.init(TARGET)
    await lease.close()
    await initPromise

    const commands = invoke.mock.calls.map(call => String(call[0]))
    expect(commands).toContain('voice_close')
    expect(commands).not.toContain('voice_open')
  })
})
