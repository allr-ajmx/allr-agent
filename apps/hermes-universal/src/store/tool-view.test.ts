import { beforeEach, describe, expect, it } from 'vitest'

import { $anyToolDisclosureOpen, $toolDisclosureOpen, $toolDisclosureStates, setToolDisclosureOpen } from './tool-view'

beforeEach(() => {
  $toolDisclosureStates.set({})
})

describe('$toolDisclosureOpen', () => {
  // Called bare in a render body — a fresh atom per render would make useStore
  // resubscribe every time.
  it('returns the SAME atom for an id so a render body can call it directly', () => {
    expect($toolDisclosureOpen('row-a')).toBe($toolDisclosureOpen('row-a'))
    expect($toolDisclosureOpen('row-a')).not.toBe($toolDisclosureOpen('row-b'))
  })

  it('reports undefined until the row is toggled, then its state', () => {
    const open = $toolDisclosureOpen('row-a')

    expect(open.get()).toBeUndefined()
    setToolDisclosureOpen('row-a', true)
    expect(open.get()).toBe(true)
    setToolDisclosureOpen('row-a', false)
    expect(open.get()).toBe(false)
  })
})

describe('$anyToolDisclosureOpen', () => {
  it('answers for the whole set — a live run asking whether one of its rows is open', () => {
    const anyOpen = $anyToolDisclosureOpen(['row-a', 'row-b'])

    expect(anyOpen.get()).toBe(false)
    setToolDisclosureOpen('row-b', true)
    expect(anyOpen.get()).toBe(true)
    setToolDisclosureOpen('row-b', false)
    expect(anyOpen.get()).toBe(false)
  })

  it('ignores rows outside its own set', () => {
    const anyOpen = $anyToolDisclosureOpen(['row-a'])

    setToolDisclosureOpen('row-elsewhere', true)
    expect(anyOpen.get()).toBe(false)
  })

  // MJXHRM-223: this used to be memoized in a module Map keyed on the JOINED id
  // list. A run gains one id per tool call, so an N-call run left N atoms behind
  // keyed by N strings of growing length — O(N²) characters retained forever, in
  // the very store a render-cost budget exists to bound. The caller scopes this
  // to a useMemo, so nothing needed the cache.
  it('retains nothing between calls', () => {
    expect($anyToolDisclosureOpen(['row-a'])).not.toBe($anyToolDisclosureOpen(['row-a']))
  })
})
