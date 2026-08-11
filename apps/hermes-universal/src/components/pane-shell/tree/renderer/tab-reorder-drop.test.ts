/**
 * Dragging a tab along its own strip — the whole path, strip DOM to committed
 * tree, because the bug this pins lived in the SEAM between the two.
 *
 * The drop caret's slot is read off the tab strip, which renders only the tabs
 * a zone SHOWS. The tree's group holds more than that: a tile its owning store
 * toggled off, and — by explicit design in `closeTreePane` — the pane of a
 * plugin that has been disabled, so re-enabling restores it in place. The
 * commit used to turn the caret's slot into an INDEX over the strip's DOM tabs
 * and hand that number to the tree, which counts in its own space, so every
 * unshown pane ahead of the slot slid the drop by one: dragging a tab to the
 * end of such a strip parked it second-to-last instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findGroup, group } from '../model'
import { $layoutTree } from '../store'

import { startPaneDrag } from './drag-session'

const GROUP = 'zone-1'

interface Box {
  left: number
  right: number
}

/** jsdom lays nothing out, and the whole gesture is rect math — so the strip
 *  and its tabs get the geometry they would have on screen. */
function laidOut<T extends HTMLElement>(el: T, { left, right }: Box): T {
  el.getBoundingClientRect = () =>
    ({ bottom: 28, height: 28, left, right, top: 0, width: right - left, x: left, y: 0 }) as DOMRect

  return el
}

/** A strip of tabs at 100px each, in the order given. */
function strip(paneIds: string[]): HTMLElement {
  const el = laidOut(document.createElement('div'), { left: 0, right: paneIds.length * 100 })

  el.dataset.zoneTabstrip = GROUP

  paneIds.forEach((paneId, i) => {
    const tab = laidOut(document.createElement('div'), { left: i * 100, right: (i + 1) * 100 })

    tab.dataset.treeTab = paneId
    el.append(tab)
  })

  document.body.append(el)

  return el
}

/** A React-shaped pointerdown on a tab; only the fields the drag reads. */
const press = (el: HTMLElement, x: number) =>
  ({
    button: 0,
    clientX: x,
    clientY: 14,
    currentTarget: el,
    pointerId: 1,
    pointerType: 'mouse',
    preventDefault: () => {},
    stopPropagation: () => {}
  }) as unknown as Parameters<typeof startPaneDrag>[1]

/** Drag from the pressed tab to `x` and release there. */
async function dragTo(x: number) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 14 }))
  // Moves are rAF-coalesced; the hit test lands on the next frame.
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  window.dispatchEvent(new MouseEvent('pointerup'))
}

const panesOf = (groupId: string) => findGroup($layoutTree.get()!, groupId)?.panes

beforeEach(() => {
  $layoutTree.set(null)
  document.body.replaceChildren()
})

afterEach(() => {
  document.body.replaceChildren()
  document.body.removeAttribute('style')
  document.body.className = ''
  $layoutTree.set(null)
})

describe('tab reorder drop lands in the slot the caret showed', () => {
  it('drops at the END of a strip whose zone also holds a pane it never draws', async () => {
    // `plugin` sits between a and b in the TREE but is not on the strip.
    $layoutTree.set(group(['a', 'plugin', 'b', 'c'], { active: 'a', id: GROUP }))

    const el = strip(['a', 'b', 'c'])

    startPaneDrag('a', press(el.children[0] as HTMLElement, 50), undefined, { groupId: GROUP, strip: el })
    // Past c's midpoint (250) — the caret sits after the last tab.
    await dragTo(290)

    expect(panesOf(GROUP)).toEqual(['plugin', 'b', 'c', 'a'])
  })

  it('drops before the tab the caret pointed at', async () => {
    $layoutTree.set(group(['a', 'plugin', 'b', 'c'], { active: 'a', id: GROUP }))

    const el = strip(['a', 'b', 'c'])

    startPaneDrag('a', press(el.children[0] as HTMLElement, 50), undefined, { groupId: GROUP, strip: el })
    // Between b's midpoint (150) and c's (250) — the caret sits before c.
    await dragTo(210)

    expect(panesOf(GROUP)).toEqual(['plugin', 'b', 'a', 'c'])
  })

  it('leaves the strip alone when the drag is abandoned', async () => {
    $layoutTree.set(group(['a', 'b', 'c'], { active: 'a', id: GROUP }))

    const el = strip(['a', 'b', 'c'])

    startPaneDrag('a', press(el.children[0] as HTMLElement, 50), undefined, { groupId: GROUP, strip: el })
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 290, clientY: 14 }))
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    // Alt-Tab: the release goes to another window, never to us.
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(panesOf(GROUP)).toEqual(['a', 'b', 'c'])
  })
})
