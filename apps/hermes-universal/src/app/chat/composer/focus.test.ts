/**
 * The late-mount focus guard (MJXHRM-6).
 *
 * A session tile is saved with no runtime id, so its composer mounts only once
 * an async resume lands — long after the ⌘T that parked it handed the caret to
 * the fresh chat in main. This predicate is what tells that late arrival to keep
 * its hands off.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { DRAFT_TILE_PANE_ID, sessionTilePaneId, WORKSPACE_PANE_ID } from '@/lib/pane-ids'

import { composerTargetForPane, focusHeldByOtherEditor } from './focus'

const mount = <T extends HTMLElement>(el: T): T => {
  document.body.append(el)
  el.focus()

  return el
}

const editable = () => {
  const el = document.createElement('div')
  el.contentEditable = 'true'
  // jsdom does not derive isContentEditable from the attribute.
  Object.defineProperty(el, 'isContentEditable', { value: true })
  el.tabIndex = 0

  return el
}

afterEach(() => {
  document.body.replaceChildren()
})

// The focused chat ZONE names the composer that `'active'` resolves to, so
// typing follows the tile you are looking at instead of the one that mounted
// last. This is that mapping.
describe('composerTargetForPane', () => {
  it('maps a tile pane to its own composer and the workspace to main', () => {
    expect(composerTargetForPane(sessionTilePaneId('abc'))).toBe('tile:abc')
    expect(composerTargetForPane(DRAFT_TILE_PANE_ID)).toBe('tile:draft')
    expect(composerTargetForPane(WORKSPACE_PANE_ID)).toBe('main')
    expect(composerTargetForPane('files')).toBe('main')
  })
})

describe('focusHeldByOtherEditor', () => {
  it('is true when another composer holds the caret', () => {
    const other = mount(editable())

    expect(focusHeldByOtherEditor(editable())).toBe(true)
    expect(document.activeElement).toBe(other)
  })

  it.each([
    ['an input', () => document.createElement('input')],
    ['a textarea', () => document.createElement('textarea')]
  ])('is true when %s holds the caret', (_label, make) => {
    mount(make())

    expect(focusHeldByOtherEditor(editable())).toBe(true)
  })

  // Refocusing yourself is not stealing.
  it('is false when the caret is already in this editor', () => {
    const self = mount(editable())

    expect(focusHeldByOtherEditor(self)).toBe(false)
  })

  it.each([
    ['the body', null],
    ['a button', () => document.createElement('button')]
  ])('is false when %s has focus', (_label, make) => {
    if (make) {
      mount(make())
    }

    expect(focusHeldByOtherEditor(editable())).toBe(false)
  })
})
