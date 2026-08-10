/**
 * The find bar's pure logic: what the counter says, where a step lands, and
 * which keys the bar owns while it is open.
 */

import { describe, expect, it } from 'vitest'

import { findBarClaimsCombo, findBarKeyAction, formatMatchLabel, stepOrdinal } from './find-in-page'

describe('formatMatchLabel', () => {
  it('says nothing before the user has asked anything', () => {
    expect(formatMatchLabel('', 0, 0)).toBe('')
    expect(formatMatchLabel('', 3, 12)).toBe('')
  })

  it('gives an honest zero rather than hiding a failed search', () => {
    expect(formatMatchLabel('nothing', 0, 0)).toBe('0/0')
  })

  it('clamps an ordinal that outran the document', () => {
    // The ordinal is a running count of steps, so a page that changed under an
    // open bar can leave it pointing past the end.
    expect(formatMatchLabel('x', 99, 12)).toBe('12/12')
    expect(formatMatchLabel('x', -4, 12)).toBe('0/12')
    expect(formatMatchLabel('x', Number.NaN, 12)).toBe('0/12')
  })

  it('reads as position/total', () => {
    expect(formatMatchLabel('x', 3, 12)).toBe('3/12')
  })
})

describe('stepOrdinal', () => {
  it('wraps in both directions, because the engine search wraps', () => {
    expect(stepOrdinal(3, 12, 'forward')).toBe(4)
    expect(stepOrdinal(12, 12, 'forward')).toBe(1)
    expect(stepOrdinal(3, 12, 'backward')).toBe(2)
    expect(stepOrdinal(1, 12, 'backward')).toBe(12)
  })

  it('lands on the first match when nothing was selected yet', () => {
    expect(stepOrdinal(0, 12, 'forward')).toBe(1)
    // Backward from nowhere goes to the end — the same thing a browser does.
    expect(stepOrdinal(0, 12, 'backward')).toBe(12)
  })

  it('has no position at all when there is nothing to be at', () => {
    expect(stepOrdinal(3, 0, 'forward')).toBe(0)
    expect(stepOrdinal(3, Number.NaN, 'backward')).toBe(0)
  })
})

describe('findBarKeyAction', () => {
  it('steps on ⌘G / ⌘⇧G from anywhere, input or not', () => {
    expect(findBarKeyAction({ key: 'g', metaKey: true })).toBe('next')
    expect(findBarKeyAction({ key: 'G', metaKey: true, shiftKey: true })).toBe('previous')
    expect(findBarKeyAction({ ctrlKey: true, key: 'g' })).toBe('next')
  })

  it('steps on bare Enter ONLY while focus is in the input', () => {
    expect(findBarKeyAction({ key: 'Enter' })).toBeNull()
    expect(findBarKeyAction({ key: 'Enter' }, { inInput: true })).toBe('next')
    expect(findBarKeyAction({ key: 'Enter', shiftKey: true }, { inInput: true })).toBe('previous')
  })

  it('closes on Escape, but leaves a modified Escape alone', () => {
    expect(findBarKeyAction({ key: 'Escape' })).toBe('close')
    expect(findBarKeyAction({ key: 'Escape', metaKey: true })).toBeNull()
  })

  it('lets Alt chords through rather than swallowing them', () => {
    expect(findBarKeyAction({ altKey: true, key: 'g', metaKey: true })).toBeNull()
    expect(findBarKeyAction({ altKey: true, key: 'Escape' })).toBeNull()
  })
})

describe('findBarClaimsCombo', () => {
  it('claims exactly the three combos that collide with real bindings', () => {
    // ⌘G is the review pane's shipped default and Escape cancels a running turn
    // — while the bar is open, neither may also fire.
    expect(findBarClaimsCombo('mod+g')).toBe(true)
    expect(findBarClaimsCombo('mod+shift+g')).toBe(true)
    expect(findBarClaimsCombo('escape')).toBe(true)
  })

  it('claims nothing else — ⌘F itself still reaches the registry', () => {
    expect(findBarClaimsCombo('mod+f')).toBe(false)
    expect(findBarClaimsCombo('mod+k')).toBe(false)
  })
})
