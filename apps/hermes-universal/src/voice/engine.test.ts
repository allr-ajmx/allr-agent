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

  it('downgrades to the web engine when the native open fails', async () => {
    h.state.failNative = true

    const lease = await voiceEngine.open('conversation', OPTS)
    expect(h.nativeCreated).toHaveLength(1) // native attempted
    expect(h.webCreated).toHaveLength(1) // and fell back to web
    expect(voiceEngine.owner).toBe('conversation')

    await lease.close()
  })
})
