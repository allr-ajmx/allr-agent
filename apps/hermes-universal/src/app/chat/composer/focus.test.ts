/**
 * The late-mount focus guard (MJXHRM-6).
 *
 * A session tile is saved with no runtime id, so its composer mounts only once
 * an async resume lands — long after the ⌘T that parked it handed the caret to
 * the fresh chat in main. This predicate is what tells that late arrival to keep
 * its hands off.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { focusHeldByOtherEditor } from './focus'

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
