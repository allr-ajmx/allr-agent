/**
 * RENAMING A PANE IN PLACE (the draft chat taking its issued session id).
 *
 * The point of the op is that nothing MOVES, so the assertions are about what
 * survives: the slot in the strip, the active flag, and the three side tables
 * that are also keyed by pane id. Losing one of those is the quiet failure —
 * the tab looks right and the pane has silently forgotten how wide it was.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { allPaneIds, findGroupOfPane, group, type GroupNode, renamePane, split } from '@/components/pane-shell/tree/model'
import {
  $dismissedPanes,
  $hiddenTreePanes,
  $layoutTree,
  renameTreePane,
  setTreePaneHidden
} from '@/components/pane-shell/tree/store'
import { $paneStates, setPaneWidthOverride } from '@/store/panes'

const DRAFT = 'session-tile:draft'
const REAL = 'session-tile:s-42'

beforeEach(() => {
  $layoutTree.set(split('row', [group(['sessions']), group([DRAFT, 'other'], { active: DRAFT, id: 'chat' })]))
  $paneStates.set({})
  $hiddenTreePanes.set(new Set())
  $dismissedPanes.set(new Set())
})

afterEach(() => {
  $layoutTree.set(null)
  $paneStates.set({})
})

describe('renamePane', () => {
  it('keeps the pane at its index in the strip', () => {
    const tree = group(['a', DRAFT, 'b'])

    expect((renamePane(tree, DRAFT, REAL) as GroupNode).panes).toEqual(['a', REAL, 'b'])
  })

  it('carries the active flag across', () => {
    const tree = group(['a', DRAFT], { active: DRAFT })

    expect((renamePane(tree, DRAFT, REAL) as GroupNode).active).toBe(REAL)
  })

  it('leaves a different active pane alone', () => {
    const tree = group(['a', DRAFT], { active: 'a' })

    expect((renamePane(tree, DRAFT, REAL) as GroupNode).active).toBe('a')
  })

  it('is a no-op for an id that is not in the tree', () => {
    const tree = group(['a', 'b'])

    expect(renamePane(tree, DRAFT, REAL)).toBe(tree)
  })

  it('refuses a rename that would duplicate an existing pane', () => {
    // The session already has a tab; renaming onto it would put one chat in the
    // strip twice, and the tree has no way back from that.
    const tree = group([DRAFT, REAL])

    expect(renamePane(tree, DRAFT, REAL)).toBe(tree)
  })

  it('reaches a pane nested in a split', () => {
    const tree = split('row', [group(['x']), split('column', [group(['y']), group([DRAFT])])])

    expect(allPaneIds(renamePane(tree, DRAFT, REAL))).toEqual(['x', 'y', REAL])
  })
})

describe('renameTreePane', () => {
  it('renames in the live tree without moving the pane', () => {
    renameTreePane(DRAFT, REAL)

    const zone = findGroupOfPane($layoutTree.get()!, REAL)

    expect(zone?.id).toBe('chat')
    expect(zone?.panes).toEqual([REAL, 'other'])
    expect(zone?.active).toBe(REAL)
  })

  it('carries the dragged width across', () => {
    setPaneWidthOverride(DRAFT, 420)

    renameTreePane(DRAFT, REAL)

    expect($paneStates.get()[REAL]?.widthOverride).toBe(420)
    expect($paneStates.get()[DRAFT]).toBeUndefined()
  })

  it('carries hidden membership across', () => {
    setTreePaneHidden(DRAFT, true)

    renameTreePane(DRAFT, REAL)

    expect($hiddenTreePanes.get().has(REAL)).toBe(true)
    expect($hiddenTreePanes.get().has(DRAFT)).toBe(false)
  })

  it('carries dismissed membership across', () => {
    $dismissedPanes.set(new Set([DRAFT]))

    renameTreePane(DRAFT, REAL)

    expect($dismissedPanes.get().has(REAL)).toBe(true)
    expect($dismissedPanes.get().has(DRAFT)).toBe(false)
  })

  it('leaves the side tables untouched when the tree refuses the rename', () => {
    // Consistency matters more than the write: a side table that moved for a
    // rename the tree rejected now describes a pane that does not exist.
    setPaneWidthOverride('session-tile:ghost', 300)

    renameTreePane('session-tile:ghost', REAL)

    expect($paneStates.get()['session-tile:ghost']?.widthOverride).toBe(300)
    expect($paneStates.get()[REAL]).toBeUndefined()
  })
})
