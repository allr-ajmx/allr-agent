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
  emit: null as ((event: unknown) => void) | null,
  // Whether the gateway is answering "no such method". The predicate itself is
  // tested in lib/gateway-rpc.test.ts; what this file owns is which refusal the
  // store reports when the answer is yes.
  missingRpc: false
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
  isMissingRpcMethod: () => h.missingRpc,
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
  h.missingRpc = false
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

  /**
   * `wake.feed` answering `fed: false` is a 200, not a rejection — `feed_audio`
   * returns False when the detector was disarmed, is owned by another transport,
   * or went back to local capture. Dropping that answer leaves this client
   * holding the user's microphone open and pushing PCM the gateway discards,
   * several times a second, for as long as the app runs.
   */
  it('releases the mic when the gateway starts discarding the audio', async () => {
    start.mockResolvedValue({ started: true, capture: 'client', phrase: 'hey hermes' })
    await toggleWakeWord()

    const lease = h.leases[0]
    expect($wakeWord.get().streaming).toBe(true)

    feed.mockResolvedValue({ fed: false, reason: 'not_owner' })
    status.mockResolvedValue({ ...STATUS, enabled: true, listening: true, owned_by_caller: false })

    h.emit?.({ type: 'wakeFrame', pcm: 'AAEC' })
    await vi.waitFor(() => expect(lease.close).toHaveBeenCalled())

    const state = $wakeWord.get()
    expect(state.streaming).toBe(false)
    expect(state.reason).toBe('not_owner')
    // Re-read rather than guessed: the backend is the one that knows who owns it.
    expect(state.owned).toBe(false)
  })

  it('acts on the discard once, not once per frame', async () => {
    start.mockResolvedValue({ started: true, capture: 'client', phrase: 'hey hermes' })
    await toggleWakeWord()

    feed.mockResolvedValue({ fed: false, reason: 'not_owner' })
    status.mockClear()

    for (let i = 0; i < 5; i += 1) {
      h.emit?.({ type: 'wakeFrame', pcm: 'AAEC' })
    }

    await vi.waitFor(() => expect(status).toHaveBeenCalled())
    // A cooldown, not a per-frame reaction: five refusals inside the window must
    // not become five mic-release/reconcile round trips.
    expect(status).toHaveBeenCalledTimes(1)
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

  it('calls a gateway without the wake methods unsupported, not a failed toggle', async () => {
    // `wake.*` arrived 2026-06-26 and `wake.feed` a month later, so an older
    // gateway is a supported configuration. The ear button has to say the
    // backend cannot do this rather than reading as a mic that broke.
    h.missingRpc = true
    start.mockRejectedValue(new Error('unknown method: wake.start'))

    await toggleWakeWord()

    const state = $wakeWord.get()
    expect(state.reason).toBe('unsupported_backend')
    expect(state.listening).toBe(false)
    expect(state.busy).toBe(false)
  })

  it('arming against a gateway without the wake methods gives up quietly', async () => {
    h.missingRpc = true
    status.mockRejectedValue(new Error('unknown method: wake.status'))

    await armWakeWord()

    const state = $wakeWord.get()
    expect(state.available).toBe(false)
    expect(state.reason).toBe('unsupported_backend')
    expect(start).not.toHaveBeenCalled()
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
    expect(starter).toHaveBeenCalledWith({ phrase: 'hey coder', profile: 'coder', startNewSession: true })
    expect($wakeWord.get().phrase).toBe('hey coder')
  })

  // The whole payload is a routing decision the BACKEND already made
  // (MJXHRM-389). Dropping any field of it puts the conversation somewhere the
  // user did not ask for, silently.
  it('carries start_new_session: false through to the starter', async () => {
    const starter = vi.fn()
    setWakeConversationStarter(starter)

    h.route?.({
      type: 'wake.detected',
      payload: { phrase: 'hey hermes', profile: null, start_new_session: false }
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starter).toHaveBeenCalledWith({ phrase: 'hey hermes', profile: null, startNewSession: false })
  })

  it('defaults start_new_session to true when the backend omits it', async () => {
    const starter = vi.fn()
    setWakeConversationStarter(starter)

    h.route?.({ type: 'wake.detected', payload: { phrase: 'hey hermes' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starter).toHaveBeenCalledWith({ phrase: 'hey hermes', profile: null, startNewSession: true })
  })

  it('normalizes a blank profile to null rather than a profile named ""', async () => {
    const starter = vi.fn()
    setWakeConversationStarter(starter)

    h.route?.({ type: 'wake.detected', payload: { phrase: 'hey hermes', profile: '  ' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starter).toHaveBeenCalledWith({ phrase: 'hey hermes', profile: null, startNewSession: true })
  })

  it('ignores every other gateway event', async () => {
    const starter = vi.fn()
    setWakeConversationStarter(starter)

    h.route?.({ type: 'message.complete', payload: {} })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(starter).not.toHaveBeenCalled()
  })
})
