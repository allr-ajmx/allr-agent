import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initAppLifecycle, onBackground, onForeground, resetAppLifecycleForTest } from './app-lifecycle'

// jsdom reports `visibilityState` from a getter, so drive it the way the browser
// would: set the state, then dispatch the event the app actually listens for.
function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  resetAppLifecycleForTest()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

describe('app-lifecycle', () => {
  it('delivers a background edge and then a foreground edge', () => {
    const order: string[] = []
    initAppLifecycle()
    onBackground(() => order.push('bg'))
    onForeground(() => order.push('fg'))

    setVisibility('hidden')
    setVisibility('visible')

    expect(order).toEqual(['bg', 'fg'])
  })

  // The common mobile teardown sequence is `visibilitychange`→hidden IMMEDIATELY
  // followed by `pagehide`. Both are wired, so without an edge guard the jar
  // snapshot (and every other background listener) would run twice per trip away.
  it('collapses a pagehide that follows the hidden transition', () => {
    const onBg = vi.fn()
    initAppLifecycle()
    onBackground(onBg)

    setVisibility('hidden')
    window.dispatchEvent(new Event('pagehide'))

    expect(onBg).toHaveBeenCalledTimes(1)
  })

  // A phone can report `visible` several times in a row while the app is already
  // in front. Waking the reconnect loop on each of those would turn a rotating
  // status bar into a redial storm.
  it('does not re-deliver a foreground edge while already foregrounded', () => {
    const onFg = vi.fn()
    initAppLifecycle()
    onForeground(onFg)

    setVisibility('visible')
    setVisibility('visible')

    expect(onFg).not.toHaveBeenCalled()
  })

  it('installs only once, however many callers ask', () => {
    const onBg = vi.fn()
    initAppLifecycle()
    initAppLifecycle()
    onBackground(onBg)

    setVisibility('hidden')

    expect(onBg).toHaveBeenCalledTimes(1)
  })

  // One listener throwing must not strand the others: the jar snapshot and the
  // reconnect wake are independent, and losing the second because the first threw
  // is exactly the silent failure this module exists to avoid.
  it('keeps delivering after a listener throws', () => {
    const second = vi.fn()
    initAppLifecycle()
    onBackground(() => {
      throw new Error('boom')
    })
    onBackground(second)

    setVisibility('hidden')

    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops delivering once a listener is torn down', () => {
    const onFg = vi.fn()
    initAppLifecycle()
    const off = onForeground(onFg)

    setVisibility('hidden')
    off()
    setVisibility('visible')

    expect(onFg).not.toHaveBeenCalled()
  })
})
