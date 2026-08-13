import { atom, type WritableAtom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionView } from '@/app/chat/session-view'

// --- mocks -----------------------------------------------------------------
const h = vi.hoisted(() => {
  type Handler = (event: unknown) => void

  const lease = {
    handlers: new Set<Handler>(),
    arm: vi.fn<(mode?: string) => Promise<void>>(async () => undefined),
    suspend: vi.fn<() => Promise<void>>(async () => undefined),
    forceTurn: vi.fn<() => Promise<void>>(async () => undefined),
    close: vi.fn<() => Promise<void>>(async () => undefined),
    on(handler: Handler) {
      lease.handlers.add(handler)

      return () => lease.handlers.delete(handler)
    },
    closed: false,
    emit(event: unknown) {
      for (const handler of lease.handlers) {
        handler(event)
      }
    }
  }

  let resolvePlayback: ((r: string) => void) | null = null

  const playback = vi.fn(
    () =>
      new Promise<string>(resolve => {
        resolvePlayback = resolve
      })
  )

  return {
    lease,
    open: vi.fn(async () => lease),
    playback,
    markInterrupted: vi.fn(),
    stopPlayback: vi.fn(),
    resolvePlayback: (r: string) => resolvePlayback?.(r),
    notify: vi.fn(),
    notifyError: vi.fn()
  }
})

vi.mock('@/store/connection', () => ({
  $connection: { get: () => ({ baseUrl: 'http://gw', token: 't' }), subscribe: () => () => undefined }
}))
// `markVoicePlaybackInterrupted` was added to the controller's barge-in path by
// MJXHRM-389/PR #227 and never added here, so the barge-in test has been throwing
// "No export defined on the mock" on main-sync ever since — a red test in the
// suite, not a passing one.
vi.mock('@/lib/voice-playback', () => ({
  markVoicePlaybackInterrupted: h.markInterrupted,
  playSpeechTextUntilDone: h.playback,
  stopVoicePlayback: h.stopPlayback
}))
vi.mock('@/store/notifications', () => ({ notify: h.notify, notifyError: h.notifyError }))
vi.mock('@/voice/engine', () => ({
  voiceEngine: { open: h.open, updateAuth: vi.fn(async () => undefined), owner: null }
}))

import {
  $voiceBargeinThreshold,
  $voiceInputGain,
  $voiceInputThreshold,
  DEFAULT_VOICE_LEVELS
} from '@/store/voice-prefs'

import { type ConversationBinding, voiceConversation } from './conversation-controller'

// --- helpers ---------------------------------------------------------------
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function assistant(id: string, text: string, pending: boolean) {
  return { id, role: 'assistant', pending, parts: [{ type: 'text', text }] }
}

const copy = new Proxy({}, { get: () => 'x' }) as ConversationBinding['copy']

// Recreated per test so the reply-cursor WeakMap (keyed by `view`) starts clean —
// otherwise a reply id spoken in one test would be deduped away in the next.

let $messages: WritableAtom<any[]>
let $busy: WritableAtom<boolean>
let view: SessionView

const submit = vi.fn(async () => {
  // Submitting starts the assistant turn: busy flips true and a pending reply
  // appears BEFORE the loop's generator first reads the store. This mirrors the
  // real app and is the crux the old regression test guarded — otherwise the turn
  // ends via the "no reply and not busy" branch and never exercises the re-arm.
  $busy.set(true)
  $messages.set([assistant('r1', '', true)])
})

function binding(overrides: Partial<ConversationBinding> = {}): ConversationBinding {
  return { view, target: 'main', submit, transcriptionAvailable: true, copy, ...overrides }
}

beforeEach(() => {
  $messages = atom<any[]>([])
  $busy = atom(false)
  view = { $messages, $busy } as unknown as SessionView
  $voiceInputGain.set(DEFAULT_VOICE_LEVELS.inputGain)
  $voiceInputThreshold.set(DEFAULT_VOICE_LEVELS.inputThreshold)
  $voiceBargeinThreshold.set(DEFAULT_VOICE_LEVELS.bargeinThreshold)
})

afterEach(async () => {
  await voiceConversation.end()
  h.open.mockClear()
  h.lease.arm.mockClear()
  h.lease.forceTurn.mockClear()
  h.lease.close.mockClear()
  h.playback.mockClear()
  h.stopPlayback.mockClear()
  submit.mockClear()
})

function armCalls(mode: string) {
  return h.lease.arm.mock.calls.filter(call => call[0] === mode).length
}

describe('conversation controller', () => {
  // MJXHRM-90: Rust takes the VAD once, at `voice_open`. A conversation that
  // opened without the persisted levels would run on the tuned constants no
  // matter what the user set — the settings page would be decorative.
  it('opens the session with the user-calibrated levels', async () => {
    $voiceInputGain.set(7.5)
    $voiceInputThreshold.set(0.2)
    $voiceBargeinThreshold.set(0.44)

    await voiceConversation.start(binding())
    await flush()

    expect(h.open).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ vad: { levelGain: 7.5, speechLevel: 0.2, bargeinSpeechLevel: 0.44 } })
    )
  })

  it('re-arms the mic after a completed spoken turn', async () => {
    await voiceConversation.start(binding())
    await flush()
    expect(h.lease.arm).toHaveBeenNthCalledWith(1, 'normal')

    h.lease.emit({ type: 'transcript', text: 'hello there' })
    await flush()
    expect(submit).toHaveBeenCalledWith('hello there')

    // Stream a reply chunk.
    $messages.set([assistant('r1', 'Hi there.', true)])
    await flush()
    expect(h.playback).toHaveBeenCalledWith('Hi there.', expect.objectContaining({ source: 'voice-conversation' }))
    expect(h.lease.arm).toHaveBeenCalledWith('bargein')

    // Complete the reply, then finish playback → the loop re-arms 'normal'.
    $messages.set([assistant('r1', 'Hi there.', false)])
    $busy.set(false)
    h.resolvePlayback('ended')
    await flush()

    expect(armCalls('normal')).toBe(2)
  })

  it('re-arms on an empty turn without submitting or ending', async () => {
    await voiceConversation.start(binding())
    await flush()
    expect(armCalls('normal')).toBe(1)

    h.lease.emit({ type: 'turnEmpty', reason: 'noSpeech' })
    await flush()

    expect(submit).not.toHaveBeenCalled()
    expect(armCalls('normal')).toBe(2)
    expect(h.lease.close).not.toHaveBeenCalled()
  })

  it('stops playback on barge-in (speechStart while speaking)', async () => {
    await voiceConversation.start(binding())
    await flush()

    h.lease.emit({ type: 'transcript', text: 'question' })
    await flush()
    $messages.set([assistant('r1', 'A long answer.', true)])
    await flush()
    // Now speaking (playback in flight). Barge in.
    h.lease.emit({ type: 'speechStart' })
    expect(h.stopPlayback).toHaveBeenCalled()

    // The interrupted playback settles 'stopped'; the loop does NOT re-arm 'normal'
    // for this turn (the barge turn drives what's next).
    h.resolvePlayback('stopped')
    await flush()
    expect(armCalls('normal')).toBe(1) // only the initial arm
  })

  // The failure used to be indistinguishable from a spoken reply: the outcome was
  // dropped and the loop re-armed the microphone, so a gateway with no TTS
  // provider left the pill lit and the ear open with nothing ever audible, and
  // `copy.playbackFailed` — translated into five languages — was never reached.
  it('reports a failed clip and still re-arms', async () => {
    await voiceConversation.start(binding())
    await flush()

    h.lease.emit({ type: 'transcript', text: 'question' })
    await flush()
    $messages.set([assistant('r1', 'An answer.', true)])
    await flush()
    expect(h.playback).toHaveBeenCalled()
    expect(h.notifyError).not.toHaveBeenCalled()

    h.resolvePlayback('error')
    await flush()

    expect(h.notifyError).toHaveBeenCalled()
    expect(armCalls('normal')).toBe(2)
  })

  it('ignores a transcript that arrives after end()', async () => {
    await voiceConversation.start(binding())
    await flush()
    await voiceConversation.end()
    submit.mockClear()

    h.lease.emit({ type: 'transcript', text: 'too late' })
    await flush()
    expect(submit).not.toHaveBeenCalled()
  })
})
