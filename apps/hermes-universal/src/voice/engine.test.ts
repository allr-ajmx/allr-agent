import { afterEach, describe, expect, it, vi } from 'vitest'

// Force the Tauri path so the engine picks the (mocked) native lease, and stub
// both lease factories with inspectable fakes.
const h = vi.hoisted(() => {
  const state = { failNative: false }
  const nativeCreated: FakeLease[] = []
  const webCreated: FakeLease[] = []

  interface FakeLease {
    init: ReturnType<typeof vi.fn>
    arm: ReturnType<typeof vi.fn>
    wakeListen: ReturnType<typeof vi.fn>
    suspend: ReturnType<typeof vi.fn>
    forceTurn: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    on: (fn: (event: unknown) => void) => () => void
    closed: boolean
  }

  const make = (onInit?: () => void): FakeLease => {
    const handlers = new Set<(event: unknown) => void>()

    return {
      init: vi.fn(async () => {
        onInit?.()
      }),
      arm: vi.fn(async () => undefined),
      wakeListen: vi.fn(async () => undefined),
      suspend: vi.fn(async () => undefined),
      forceTurn: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      on: fn => {
        handlers.add(fn)

        return () => handlers.delete(fn)
      },
      closed: false
    }
  }

  return {
    state,
    nativeCreated,
    webCreated,
    makeNative: () => {
      const lease = make(() => {
        if (state.failNative) {
          throw new Error('native boom')
        }
      })

      nativeCreated.push(lease)

      return lease
    },
    makeWeb: () => {
      const lease = make()
      webCreated.push(lease)

      return lease
    }
  }
})

vi.mock('@/lib/platform', () => ({ IS_TAURI: true }))
vi.mock('./native-engine', () => ({ createNativeLease: () => h.makeNative() }))
vi.mock('./web-engine', () => ({ createWebLease: () => h.makeWeb() }))

import { voiceEngine } from './engine'
import { VoiceBusyError } from './errors'

const OPTS = { target: { baseUrl: 'http://gw', headers: {} } }

describe('voice engine lease arbitration', () => {
  // Each test closes the lease it opens, so the singleton returns to owner=null;
  // afterEach only resets the fakes. The downgrade test runs last because it
  // latches the engine's one-shot `downgraded` flag for the rest of the module.
  afterEach(() => {
    h.state.failNative = false
    h.nativeCreated.length = 0
    h.webCreated.length = 0
  })

  it('refuses dictation while a conversation holds the mic', async () => {
    const conversation = await voiceEngine.open('conversation', OPTS)
    expect(voiceEngine.owner).toBe('conversation')

    await expect(voiceEngine.open('dictation', OPTS)).rejects.toBeInstanceOf(VoiceBusyError)

    await conversation.close()
    expect(voiceEngine.owner).toBeNull()
  })

  it('lets a conversation preempt active dictation', async () => {
    await voiceEngine.open('dictation', OPTS)
    const dictationLease = h.nativeCreated[0]

    const conversation = await voiceEngine.open('conversation', OPTS)
    expect(voiceEngine.owner).toBe('conversation')
    // The preempted dictation lease was closed.
    expect(dictationLease.close).toHaveBeenCalled()

    await conversation.close()
  })

  it('wake listening yields the device to anything the user asked for', async () => {
    const wake = await voiceEngine.open('wake', OPTS)
    const wakeLease = h.nativeCreated[0]
    expect(voiceEngine.owner).toBe('wake')

    // Wake is the standing background listener: a conversation preempts it
    // outright rather than being refused.
    const conversation = await voiceEngine.open('conversation', OPTS)
    expect(voiceEngine.owner).toBe('conversation')
    expect(wakeLease.close).toHaveBeenCalled()
    expect(wake).toBeDefined()

    // ...and it can never take the device back while one is live.
    await expect(voiceEngine.open('wake', OPTS)).rejects.toBeInstanceOf(VoiceBusyError)

    await conversation.close()
  })

  it('wake also yields to the momentary dictation button', async () => {
    await voiceEngine.open('wake', OPTS)
    const wakeLease = h.nativeCreated[0]

    const dictation = await voiceEngine.open('dictation', OPTS)
    expect(voiceEngine.owner).toBe('dictation')
    expect(wakeLease.close).toHaveBeenCalled()

    await dictation.close()
  })

  // The settings level meter is something the user pressed a button for, so it
  // outranks the standing wake listener — but calibrating must never cut into a
  // real turn, so it loses to both conversation and dictation.
  it('the settings meter preempts wake but never a live turn', async () => {
    await voiceEngine.open('wake', OPTS)
    const wakeLease = h.nativeCreated[0]

    const meter = await voiceEngine.open('meter', OPTS)
    expect(voiceEngine.owner).toBe('meter')
    expect(wakeLease.close).toHaveBeenCalled()

    // ...and cannot be taken back while the user is calibrating. Ranking the two
    // the SAME still lets the meter preempt wake, so this is the assertion that
    // distinguishes a real ordering from a tie.
    await expect(voiceEngine.open('wake', OPTS)).rejects.toBeInstanceOf(VoiceBusyError)
    expect(voiceEngine.owner).toBe('meter')

    await meter.close()

    const conversation = await voiceEngine.open('conversation', OPTS)
    await expect(voiceEngine.open('meter', OPTS)).rejects.toBeInstanceOf(VoiceBusyError)
    await conversation.close()

    const dictation = await voiceEngine.open('dictation', OPTS)
    await expect(voiceEngine.open('meter', OPTS)).rejects.toBeInstanceOf(VoiceBusyError)
    await dictation.close()
  })

  it('a conversation takes the device back from the meter', async () => {
    await voiceEngine.open('meter', OPTS)
    const meterLease = h.nativeCreated[0]

    const conversation = await voiceEngine.open('conversation', OPTS)
    expect(voiceEngine.owner).toBe('conversation')
    expect(meterLease.close).toHaveBeenCalled()

    await conversation.close()
  })

  it('downgrades to the web engine when the native open fails', async () => {
    h.state.failNative = true

    const lease = await voiceEngine.open('conversation', OPTS)
    expect(h.nativeCreated).toHaveLength(1) // native attempted
    expect(h.webCreated).toHaveLength(1) // and fell back to web
    expect(voiceEngine.owner).toBe('conversation')

    await lease.close()
  })
})
