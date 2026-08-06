import { beforeEach, describe, expect, it } from 'vitest'

import { $petActivity, setPetActivity } from './pet'

/**
 * Regression: `setPetActivity` used to spread into a fresh object on every call,
 * and event-router calls it once per REASONING DELTA — i.e. per token. nanostores
 * compares by identity, so every subscriber re-ran per token while the value was
 * unchanged after the first.
 */
describe('setPetActivity', () => {
  beforeEach(() => {
    $petActivity.set({})
  })

  it('notifies when a flag actually changes', () => {
    let notifications = 0

    const off = $petActivity.subscribe(() => {
      notifications += 1
    })

    // nanostores fires once on subscribe.
    const baseline = notifications

    setPetActivity({ reasoning: true })

    expect(notifications).toBe(baseline + 1)
    expect($petActivity.get().reasoning).toBe(true)
    off()
  })

  it('does NOT notify when every flag already holds that value', () => {
    setPetActivity({ reasoning: true })

    let notifications = 0

    const off = $petActivity.subscribe(() => {
      notifications += 1
    })

    const baseline = notifications

    // The per-token case: same value, over and over.
    for (let i = 0; i < 50; i += 1) {
      setPetActivity({ reasoning: true })
    }

    expect(notifications).toBe(baseline)
    off()
  })

  it('leaves sibling flags intact when one changes', () => {
    setPetActivity({ busy: true })
    setPetActivity({ reasoning: true })

    expect($petActivity.get()).toMatchObject({ busy: true, reasoning: true })
  })

  it('notifies when a flag flips back to false', () => {
    setPetActivity({ reasoning: true })

    let notifications = 0

    const off = $petActivity.subscribe(() => {
      notifications += 1
    })

    const baseline = notifications

    setPetActivity({ reasoning: false })

    expect(notifications).toBe(baseline + 1)
    expect($petActivity.get().reasoning).toBe(false)
    off()
  })

  it('notifies when one of several flags is new', () => {
    setPetActivity({ reasoning: true })

    let notifications = 0

    const off = $petActivity.subscribe(() => {
      notifications += 1
    })

    const baseline = notifications

    setPetActivity({ reasoning: true, toolRunning: true })

    expect(notifications).toBe(baseline + 1)
    expect($petActivity.get()).toMatchObject({ reasoning: true, toolRunning: true })
    off()
  })
})
