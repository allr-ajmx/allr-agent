/**
 * The composer's completion popover opens on the keystroke and fills a beat
 * later (60ms debounce + an RPC). Tab pressed inside that window fell through to
 * the browser and moved focus out of the composer — the popover appeared to eat
 * the key and take the caret with it.
 *
 * `swallowsTriggerTab` is that decision, and it is a function precisely so it can
 * be pinned here: the keydown handler it is called from lives inside `ChatBar`,
 * which cannot be mounted in a unit test.
 */

import { describe, expect, it } from 'vitest'

import { swallowsTriggerTab } from './composer-utils'

const inFlight = { itemCount: 0, key: 'Tab', loading: true, open: true }

describe('swallowsTriggerTab', () => {
  it('swallows Tab while the open popover has nothing to offer yet', () => {
    expect(swallowsTriggerTab(inFlight)).toBe(true)
  })

  // Tab with items ACCEPTS the highlighted one (and descends into a folder), so
  // this branch must not claim it first.
  it('leaves Tab to the accept branch once items have landed', () => {
    expect(swallowsTriggerTab({ ...inFlight, itemCount: 3 })).toBe(false)
  })

  it('leaves Tab alone when nothing is in flight', () => {
    expect(swallowsTriggerTab({ ...inFlight, loading: false })).toBe(false)
  })

  // No popover, no claim: Tab out of the composer is how the keyboard reaches
  // the rest of the app, and swallowing it here would be a focus trap.
  it('never claims Tab with no popover open', () => {
    expect(swallowsTriggerTab({ ...inFlight, open: false })).toBe(false)
  })

  it('claims Tab only — every other key still types or navigates', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'Escape', 'a', 'Backspace']) {
      expect(swallowsTriggerTab({ ...inFlight, key })).toBe(false)
    }
  })
})
