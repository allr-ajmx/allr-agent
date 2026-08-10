/**
 * The wake word is a microphone that can be left on, so the properties worth
 * testing are the ones that keep it honest: only a deliberate click may persist
 * `wake_word.enabled`, we stream PCM only when the backend asks us to, and the
 * device is handed cleanly back and forth with a voice conversation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted: the module under test registers its gateway listener at IMPORT
// time, so the factory has to run before any normal top-level binding.
const h = vi.hoisted(() => ({
  route: null as ((event: { payload?: unknown; type: string }) => void) | null,
  leases: [] as { close: ReturnType<typeof vi.fn>; wakeListen: ReturnType<typeof vi.fn> }[],
  openFails: false,
  emit: null as ((event: unknown) => void) | null
}))

vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: (listener: (event: { payload?: unknown; type: string }) => void) => {
    h.route = listener

    return () => {
      h.route = null
    }
  }
}))

vi.mock('@/lib/gateway-rpc', () => ({
  isMissingRpcMethod: () => false,
  feedWakeAudio: vi.fn().mockResolvedValue({ fed: true, reason: null }),
  startWakeWord: vi.fn(),
  stopWakeWord: vi.fn(),
  wakeWordStatus: vi.fn(),
  pauseWakeWord: vi.fn().mockResolvedValue({ paused: true, reason: null }),
  resumeWakeWord: vi.fn().mockResolvedValue({ resumed: true, reason: null })
}))

vi.mock('@/lib/wake-sound', () => ({ playWakeSound: vi.fn() }))

vi.mock('@/voice/engine', () => ({
  voiceEngine: {
    open: vi.fn(async () => {
      if (h.openFails) {
        throw new Error('no_input_device')
      }

      const lease = {
        close: vi.fn(async () => undefined),
        wakeListen: vi.fn(async () => undefined),
        on: (handler: (event: unknown) => void) => {
          h.emit = handler

          return () => {
            h.emit = null
          }
        }
      }

      h.leases.push(lease)

      return lease
    })
  }
}))

import {
  feedWakeAudio,
  pauseWakeWord,
  resumeWakeWord,
  startWakeWord,
  stopWakeWord,
  wakeWordStatus
} from '@/lib/gateway-rpc'
import { playWakeSound } from '@/lib/wake-sound'
import { voiceEngine } from '@/voice/engine'

import {
  $wakeWord,
  armWakeWord,
  pauseWakeForVoice,
  resumeWakeAfterVoice,
  setWakeConversationStarter,
  toggleWakeWord
} from './wake-word'

const start = vi.mocked(startWakeWord)
const stop = vi.mocked(stopWakeWord)
const status = vi.mocked(wakeWordStatus)
const feed = vi.mocked(feedWakeAudio)
const open = vi.mocked(voiceEngine.open)

const STATUS = {
  listening: false,
  owned_by_caller: false,
  available: true,
  enabled: false,
  capture: 'local' as const,
  phrase: 'hey hermes'
}

/** Reset the module singleton's observable surface between tests. */
async function reset(): Promise<void> {
  // Ending any capture the previous test left open.
  await pauseWakeForVoice()
  $wakeWord.set({
    available: false,
    enabled: false,
    listening: false,
    owned: false,
    capture: 'local',
    phrase: 'hey hermes',
    reason: null,
    hint: null,
    pausedForVoice: false,
    streaming: false,
    busy: false
  })
}

beforeEach(async () => {
  await reset()
  h.leases.length = 0
  h.emit = null
  h.openFails = false
  vi.clearAllMocks()
  status.mockResolvedValue({ ...STATUS })
  start.mockResolvedValue({ started: true, capture: 'local', phrase: 'hey hermes' })
  stop.mockResolvedValue({ stopped: true, disabled_persisted: true })
  vi.mocked(pauseWakeWord).mockResolvedValue({ paused: true, reason: null })
  vi.mocked(resumeWakeWord).mockResolvedValue({ resumed: true, reason: null })
})

afterEach(() => setWakeConversationStarter(null))

describe('the toggle IS the config', () => {
  it('persists on the click, in both directions', async () => {
    await toggleWakeWord()
    expect(start).toHaveBeenCalledWith({ persist: true })
    expect($wakeWord.get().enabled).toBe(true)

    await toggleWakeWord()
    expect(stop).toHaveBeenCalledWith({ persist: true })
    expect($wakeWord.get().enabled).toBe(false)
  })

  it('never persists on a passive re-arm', async () => {
    status.mockResolvedValue({ ...STATUS, enabled: true })

    await armWakeWord()

    // `{ persist: false }` — a window opening must not be able to turn a
    // microphone permanently on.
    expect(start).toHaveBeenCalledWith({ persist: false })
  })

  it('does not arm at all when the config says disabled', async () => {
    await armWakeWord()

    expect(start).not.toHaveBeenCalled()
    expect($wakeWord.get().listening).toBe(false)
  })
})

describe('capture mode', () => {
  it('streams PCM only when the backend answers capture: client', async () => {
    start.mockResolvedValue({ started: true, capture: 'client', phrase: 'hey hermes' })

    await toggleWakeWord()

    expect(open).toHaveBeenCalledWith('wake', expect.anything())
    expect(h.leases[0].wakeListen).toHaveBeenCalled()
    expect($wakeWord.get().streaming).toBe(true)

    h.emit?.({ type: 'wakeFrame', pcm: 'AAEC' })
    expect(feed).toHaveBeenCalledWith('AAEC')
  })

  it('leaves the mic alone when the backend has its own', async () => {
    await toggleWakeWord()

    expect(open).not.toHaveBeenCalled()
    expect($wakeWord.get().streaming).toBe(false)
  })

  it('reports a refusal instead of arming a detector nothing will feed', async () => {
    start.mockResolvedValue({ started: true, capture: 'client', phrase: 'hey hermes' })
    h.openFails = true

    await toggleWakeWord()

    expect($wakeWord.get().streaming).toBe(false)
    expect($wakeWord.get().reason).toBe('capture_failed')
  })

  it('surfaces a start refusal without claiming to listen', async () => {
    start.mockResolvedValue({ started: false, reason: 'unavailable', hint: 'install onnxruntime' })

    await toggleWakeWord()

    const state = $wakeWord.get()
    expect(state.listening).toBe(false)
    expect(state.available).toBe(false)
    expect(state.reason).toBe('unavailable')
    expect(state.hint).toBe('install onnxruntime')
  })
})

describe('handover with a voice conversation', () => {
  it('releases both ends of the mic on pause', async () => {
    start.mockResolvedValue({ started: true, capture: 'client', phrase: 'hey hermes' })
    await toggleWakeWord()
    const lease = h.leases[0]

    await pauseWakeForVoice()

    expect(lease.close).toHaveBeenCalled() // ours
    expect(pauseWakeWord).toHaveBeenCalled() // and the detector's
    expect($wakeWord.get().pausedForVoice).toBe(true)
  })

  it('is a no-op when nothing was listening', async () => {
    await pauseWakeForVoice()

    expect(pauseWakeWord).not.toHaveBeenCalled()
  })

  it('reconciles rather than trusting a resume that lost the mic race', async () => {
    await toggleWakeWord()
    await pauseWakeForVoice()
    vi.mocked(resumeWakeWord).mockResolvedValue({ resumed: false, reason: 'not_owner' })
    status.mockResolvedValue({ ...STATUS, enabled: true })

    await resumeWakeAfterVoice()

    // The failed resume fell through to a full status-then-start.
    expect(start).toHaveBeenCalledWith({ persist: false })
    expect($wakeWord.get().pausedForVoice).toBe(false)
  })
})

describe('wake.detected', () => {
  it('frees the mic, chimes, then opens a conversation', async () => {
    start.mockResolvedValue({ started: true, capture: 'client', phrase: 'hey hermes' })
    await toggleWakeWord()
    const lease = h.leases[0]

    const starter = vi.fn()
    setWakeConversationStarter(starter)

    h.route?.({ type: 'wake.detected', payload: { phrase: 'hey coder', profile: 'coder' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(lease.close).toHaveBeenCalled()
    expect(playWakeSound).toHaveBeenCalled()
    expect(starter).toHaveBeenCalledWith('coder')
    expect($wakeWord.get().phrase).toBe('hey coder')
  })

  it('ignores every other gateway event', async () => {
    const starter = vi.fn()
    setWakeConversationStarter(starter)

    h.route?.({ type: 'message.complete', payload: {} })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starter).not.toHaveBeenCalled()
  })
})
