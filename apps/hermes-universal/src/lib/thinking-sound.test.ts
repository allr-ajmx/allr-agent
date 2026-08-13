/**
 * The thinking blips are audio nobody asked for, played while a microphone is in
 * the room. So the properties worth pinning are the ones that keep them from
 * outstaying their welcome: they play in exactly one status, they stop for every
 * other one, and both gates (`voice.thinking_sound`, the shared sound mute) can
 * actually silence them.
 *
 * `isThinkingSoundActive()` is the observable — WebAudio itself is not
 * constructible in jsdom, and what could break here is the SCHEDULING, not the
 * oscillator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $hapticsMuted } from '@/store/haptics'
import type { VoiceConversationState } from '@/store/voice-conversation'
import { $thinkingSoundEnabled } from '@/store/voice-prefs'

import { isThinkingSoundActive, startThinkingSound, stopThinkingSound, syncThinkingSound } from './thinking-sound'

const state = (over: Partial<VoiceConversationState> = {}): VoiceConversationState => ({
  active: true,
  target: 'main',
  status: 'thinking',
  level: 0,
  muted: false,
  ...over
})

beforeEach(() => {
  vi.useFakeTimers()
  stopThinkingSound()
  $thinkingSoundEnabled.set(true)
  $hapticsMuted.set(false)
})

afterEach(() => {
  stopThinkingSound()
  vi.useRealTimers()
})

describe('thinking sound', () => {
  it('plays only while the agent is working', () => {
    syncThinkingSound(state({ status: 'thinking' }))

    expect(isThinkingSoundActive()).toBe(true)
  })

  it.each(['listening', 'transcribing', 'speaking', 'idle'] as const)('stops for status %s', status => {
    syncThinkingSound(state({ status: 'thinking' }))
    syncThinkingSound(state({ status }))

    expect(isThinkingSoundActive()).toBe(false)
  })

  it('stops when the conversation ends', () => {
    syncThinkingSound(state())
    syncThinkingSound(state({ active: false, status: 'idle', target: null }))

    expect(isThinkingSoundActive()).toBe(false)
  })

  it('stops when the conversation is muted mid-think', () => {
    syncThinkingSound(state())
    syncThinkingSound(state({ muted: true }))

    expect(isThinkingSoundActive()).toBe(false)
  })

  it('never starts for a conversation this app is not running', () => {
    syncThinkingSound(state({ active: false }))

    expect(isThinkingSoundActive()).toBe(false)
  })

  it('respects voice.thinking_sound being off', () => {
    $thinkingSoundEnabled.set(false)
    syncThinkingSound(state())

    expect(isThinkingSoundActive()).toBe(false)
  })

  it('is idempotent — re-syncing the same status does not stack a second loop', () => {
    syncThinkingSound(state())
    const firstTimerCount = vi.getTimerCount()
    syncThinkingSound(state())

    expect(vi.getTimerCount()).toBe(firstTimerCount)
  })

  it('keeps rescheduling itself, so a long tool run stays covered', () => {
    startThinkingSound()
    // First blip lands at 400 ms, then one every 800–1200 ms. Running well past
    // both proves the loop re-arms rather than firing once.
    vi.advanceTimersByTime(5_000)

    expect(isThinkingSoundActive()).toBe(true)
  })

  it('stops instantly, leaving no timer behind', () => {
    startThinkingSound()
    stopThinkingSound()

    expect(isThinkingSoundActive()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  // The shared mute is read per BLIP rather than latched at start: muting during
  // a long think has to take effect now, not next conversation. There is no
  // audio to assert on in jsdom, so what is pinned is that muting does not tear
  // the loop down (the blips resume the moment it is unmuted).
  it('stays scheduled while muted, so unmuting resumes without a new turn', () => {
    syncThinkingSound(state())
    $hapticsMuted.set(true)
    vi.advanceTimersByTime(3_000)

    expect(isThinkingSoundActive()).toBe(true)
  })
})
