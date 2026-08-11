import { describe, expect, it } from 'vitest'

import { findGroup, findGroupOfPane, group, mergeZonesWithPane, movePanes, reorderPanesInGroup, split } from './model'
import { $tabSelection, clearTabSelection, selectionFor, selectTabRange, toggleTabSelected } from './tab-selection'

describe('movePanes (multi-tab drag)', () => {
  it('stacks the whole block into the target group at the divider slot, in strip order', () => {
    const tree = split('row', [
      group(['a', 'b', 'c'], { active: 'a', id: 'left' }),
      group(['x', 'y'], { active: 'x', id: 'right' })
    ])

    const next = movePanes(tree, ['a', 'c'], { before: 'y', groupId: 'right', pos: 'center' }, 'c')
    const right = findGroup(next, 'right')

    expect(right).toMatchObject({ panes: ['x', 'a', 'c', 'y'], active: 'c' })
    expect(findGroup(next, 'left')).toMatchObject({ panes: ['b'] })
  })

  it('an edge drop opens ONE split holding the block as tabs, pressed tab fronted', () => {
    const tree = split('row', [
      group(['a', 'b', 'c'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'right' })
    ])

    const next = movePanes(tree, ['b', 'c'], { groupId: 'right', pos: 'bottom' }, 'b')
    const landed = findGroupOfPane(next, 'b')

    expect(landed).toMatchObject({ panes: ['b', 'c'], active: 'b' })
    // One new zone, not one per pane: b and c share a group.
    expect(findGroupOfPane(next, 'c')).toBe(landed)
    expect(findGroup(next, 'left')).toMatchObject({ panes: ['a'] })
  })

  it('dragging a whole zone into a sibling dissolves the source zone', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'right' })
    ])

    const next = movePanes(tree, ['a', 'b'], { groupId: 'right', pos: 'center' }, 'a')

    expect(next).toMatchObject({ type: 'group', panes: ['x', 'a', 'b'], active: 'a' })
  })

  it('is a no-op when removal dissolves the target zone itself', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'right' })
    ])

    // Dropping right's only pane (as part of a block) "into right" — the
    // target vanishes with the removal, so nothing moves.
    expect(movePanes(tree, ['x', 'a'], { groupId: 'right', pos: 'center' }, 'x')).toBe(tree)
  })

  it('falls back to single-pane semantics for a one-id block', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'right' })
    ])

    const next = movePanes(tree, ['b'], { groupId: 'right', pos: 'center' })

    expect(findGroup(next, 'right')).toMatchObject({ panes: ['x', 'b'], active: 'b' })
  })

  // A drag outlives its source: the session behind a tab can close, and a
  // profile switch prunes the other profile's tile panes. The commit reads the
  // LIVE tree, so by release the id can already be gone — and re-inserting it
  // would mint a tab nothing backs, invisible but persisted with the layout.
  it('drops panes that left the tree mid-drag instead of minting phantom tabs', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'right' })
    ])

    const next = movePanes(tree, ['a', 'closed-mid-drag'], { groupId: 'right', pos: 'center' }, 'a')

    expect(findGroup(next, 'right')).toMatchObject({ panes: ['x', 'a'] })
    expect(findGroupOfPane(next, 'closed-mid-drag')).toBeNull()
  })

  it('is a no-op when the WHOLE block left the tree mid-drag', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'right' })
    ])

    expect(movePanes(tree, ['gone-1', 'gone-2'], { groupId: 'right', pos: 'center' })).toBe(tree)
    expect(movePanes(tree, ['gone-1'], { groupId: 'right', pos: 'center' })).toBe(tree)
  })
})

describe('reorderPanesInGroup (block reorder)', () => {
  it('moves a selection as one unit, preserving its internal order', () => {
    const tree = group(['a', 'b', 'c', 'd'], { active: 'a', id: 'g' })

    // [a, c] to the END of the strip (null = no anchor tab after them).
    expect(reorderPanesInGroup(tree, 'g', ['a', 'c'], null)).toMatchObject({ panes: ['b', 'd', 'a', 'c'] })
    // ...and landing before a named tab.
    expect(reorderPanesInGroup(tree, 'g', ['c', 'd'], 'b')).toMatchObject({ panes: ['a', 'c', 'd', 'b'] })
  })

  it('leaves the group alone when any id is missing (stale selection)', () => {
    const tree = group(['a', 'b'], { active: 'a', id: 'g' })

    expect(reorderPanesInGroup(tree, 'g', ['a', 'ghost'], null)).toBe(tree)
  })

  it('leaves the group alone when the anchor tab left mid-drag', () => {
    const tree = group(['a', 'b'], { active: 'a', id: 'g' })

    expect(reorderPanesInGroup(tree, 'g', ['a'], 'closed-while-dragging')).toBe(tree)
  })

  // The slot is a pane ID because the strip and the tree do not share an index
  // space: `plugin` is in the group but off screen (its plugin was disabled,
  // and closeTreePane leaves the id in the tree on purpose), so the strip draws
  // three tabs while the group holds four.
  it('lands at the strip slot even when the zone holds a pane the strip never draws', () => {
    const tree = group(['a', 'plugin', 'b', 'c'], { active: 'a', id: 'g' })

    // `a` dragged to the end of the strip lands after every OTHER tab.
    expect(reorderPanesInGroup(tree, 'g', ['a'], null)).toMatchObject({ panes: ['plugin', 'b', 'c', 'a'] })
    // ...and dropping it on `c`'s left edge puts it between b and c.
    expect(reorderPanesInGroup(tree, 'g', ['a'], 'c')).toMatchObject({ panes: ['plugin', 'b', 'a', 'c'] })
  })
})

describe('mergeZonesWithPane with a multi-tab block', () => {
  it('merges the span into one group led by the block in strip order', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      split('column', [group(['x'], { active: 'x', id: 'mid' }), group(['y'], { active: 'y', id: 'right' })])
    ])

    const next = mergeZonesWithPane(tree, ['mid', 'right'], ['a', 'b'])

    expect(next).toMatchObject({ type: 'group', panes: ['a', 'b', 'x', 'y'] })
  })

  it('returns null for a non-rectangular span (caller falls back to a single-zone drop)', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      group(['x'], { active: 'x', id: 'mid' }),
      group(['y'], { active: 'y', id: 'right' })
    ])

    expect(mergeZonesWithPane(tree, ['mid', 'right'], ['a', 'b'])).toBeNull()
  })

  it('never seeds the merged group with a pane that left the tree mid-drag', () => {
    const tree = split('row', [
      group(['a', 'b'], { active: 'a', id: 'left' }),
      split('column', [group(['x'], { active: 'x', id: 'mid' }), group(['y'], { active: 'y', id: 'right' })])
    ])

    const next = mergeZonesWithPane(tree, ['mid', 'right'], ['a', 'gone'])!

    // `a` leads the merged zone; `gone` is nowhere, and `b` keeps the source.
    expect(findGroupOfPane(next, 'a')).toMatchObject({ panes: ['a', 'x', 'y'] })
    expect(findGroupOfPane(next, 'gone')).toBeNull()
    expect(findGroupOfPane(next, 'b')).toMatchObject({ panes: ['b'] })
    // Nothing of the block survives: no merge at all, so the caller falls back.
    expect(mergeZonesWithPane(tree, ['mid', 'right'], ['gone'])).toBeNull()
  })
})

describe('tab selection (Chrome grammar)', () => {
  it('⌥-click seeds with the active tab, toggles, and dissolves at ≤1', () => {
    clearTabSelection()
    toggleTabSelected('g', 'c', 'a')

    expect([...$tabSelection.get()!.ids].sort()).toEqual(['a', 'c'])

    toggleTabSelected('g', 'c', 'a')

    expect($tabSelection.get()).toBeNull()
  })

  it('shift-click ranges from the anchor and re-ranges on the next shift-click', () => {
    clearTabSelection()

    const order = ['a', 'b', 'c', 'd']
    selectTabRange('g', order, 'c', 'a')

    expect(selectionFor('g', order, 'b')).toEqual(['a', 'b', 'c'])

    // Anchor holds at a (Chrome): re-ranging to d replaces, not extends.
    selectTabRange('g', order, 'd', 'a')

    expect(selectionFor('g', order, 'd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('selectionFor answers null for an unselected pressed tab and drops stale ids', () => {
    clearTabSelection()
    toggleTabSelected('g', 'b', 'a')
    toggleTabSelected('g', 'c', 'a')

    // Pressed tab outside the selection = single-tab drag.
    expect(selectionFor('g', ['a', 'b', 'c', 'd'], 'd')).toBeNull()
    // 'a' closed since: it silently falls out, strip order preserved.
    expect(selectionFor('g', ['b', 'c', 'd'], 'b')).toEqual(['b', 'c'])
    // Another zone never sees it.
    expect(selectionFor('other', ['b', 'c'], 'b')).toBeNull()

    clearTabSelection()
  })
})
