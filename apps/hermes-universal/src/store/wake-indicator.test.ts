/**
 * The wake indicator is a light that turns itself on without anyone clicking
 * anything, so the properties worth pinning are the two ways it can lie: showing
 * for a conversation the wake word did not start, and staying on after the
 * conversation it belongs to is over.
 *
 * The gap between `wake.detected` and the conversation actually opening is the
 * subtle one — during it the conversation reads `active: false`, which is the
 * same shape as "ended".
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { $wakeIndicator, activateWakeIndicator, clearWakeIndicator, syncWakeIndicatorWithVoice } from './wake-indicator'

beforeEach(() => {
  clearWakeIndicator()
})

describe('wake indicator', () => {
  it('starts hidden', () => {
    expect($wakeIndicator.get()).toBe('hidden')
  })

  it('lights up on detection, before any conversation exists', () => {
    activateWakeIndicator()

    expect($wakeIndicator.get()).toBe('detected')
  })

  it('survives the gap between detection and the conversation opening', () => {
    activateWakeIndicator()

    // The composer's effect runs on the render BEFORE `start()` has flipped the
    // conversation active. Without the "has not started yet" guard this hides an
    // indicator that has just been lit.
    expect(syncWakeIndicatorWithVoice(false, 'idle')).toBe(false)
    expect($wakeIndicator.get()).toBe('detected')
  })

  it('goes solid while the conversation is listening', () => {
    activateWakeIndicator()
    syncWakeIndicatorWithVoice(true, 'listening')

    expect($wakeIndicator.get()).toBe('capturing')
  })

  it('breathes again while the agent works or speaks', () => {
    activateWakeIndicator()
    syncWakeIndicatorWithVoice(true, 'listening')
    syncWakeIndicatorWithVoice(true, 'thinking')

    expect($wakeIndicator.get()).toBe('detected')

    syncWakeIndicatorWithVoice(true, 'speaking')

    expect($wakeIndicator.get()).toBe('detected')
  })

  it('hides when the wake-started conversation ends', () => {
    activateWakeIndicator()
    syncWakeIndicatorWithVoice(true, 'listening')

    expect(syncWakeIndicatorWithVoice(false, 'idle')).toBe(true)
    expect($wakeIndicator.get()).toBe('hidden')
  })

  it('ignores a conversation the user started by hand', () => {
    // No `activateWakeIndicator()` — nothing woke anything.
    expect(syncWakeIndicatorWithVoice(true, 'listening')).toBe(false)
    expect($wakeIndicator.get()).toBe('hidden')
  })

  it('does not re-light after the conversation it belonged to has ended', () => {
    activateWakeIndicator()
    syncWakeIndicatorWithVoice(true, 'listening')
    syncWakeIndicatorWithVoice(false, 'idle')

    // A later hand-started conversation must not inherit the finished one's
    // ownership — that is how a light ends up on with nothing behind it.
    expect(syncWakeIndicatorWithVoice(true, 'listening')).toBe(false)
    expect($wakeIndicator.get()).toBe('hidden')
  })

  it('clears from an unmount mid-conversation', () => {
    activateWakeIndicator()
    syncWakeIndicatorWithVoice(true, 'listening')
    clearWakeIndicator()

    expect($wakeIndicator.get()).toBe('hidden')
    // And ownership went with it: the conversation may still be running, but
    // this surface no longer speaks for the indicator.
    expect(syncWakeIndicatorWithVoice(true, 'listening')).toBe(false)
  })

  it('publishes every transition to subscribers (the MJXHRM-228 seam)', () => {
    const seen: string[] = []
    const off = $wakeIndicator.subscribe(state => seen.push(state))

    activateWakeIndicator()
    syncWakeIndicatorWithVoice(true, 'listening')
    syncWakeIndicatorWithVoice(true, 'thinking')
    syncWakeIndicatorWithVoice(false, 'idle')
    off()

    // A native notch surface subscribing here must see the same sequence the
    // in-window pill does — no state may be pushed anywhere else.
    expect(seen).toEqual(['hidden', 'detected', 'capturing', 'detected', 'hidden'])
  })
})
