/**
 * The keep-alive lookup policy (MJXHRM-170).
 *
 * These exist because the failure they prevent is invisible. With keep-alive,
 * an inactive tab is still in the DOM with an IDENTICAL layout box to the
 * visible one — so `document.querySelector('[data-slot="composer-root"]')`
 * returns whichever comes first in document order, and the app focuses, scrolls
 * or drops into the wrong tab with no error anywhere.
 */

import { describe, expect, it } from 'vitest'

import { hiddenPaneProps, PANE_HIDDEN_ATTR, queryAllVisible, queryVisible } from './pane-visibility'

/** Two stacked tabs: the hidden one FIRST, which is the case a naive
 *  `querySelector` gets wrong. */
function stack(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `
    <div ${PANE_HIDDEN_ATTR}>
      <div class="viewport" id="hidden-viewport"><span class="composer" id="hidden-composer"></span></div>
    </div>
    <div>
      <div class="viewport" id="active-viewport"><span class="composer" id="active-composer"></span></div>
    </div>
  `
  document.body.appendChild(root)

  return root
}

describe('queryVisible', () => {
  it('skips a hidden tab even when it comes first in document order', () => {
    const root = stack()

    expect(document.querySelector('.viewport')?.id).toBe('hidden-viewport')
    expect(queryVisible('.viewport', root)?.id).toBe('active-viewport')

    root.remove()
  })

  it('skips descendants of a hidden tab, not just its root', () => {
    const root = stack()

    expect(queryVisible('.composer', root)?.id).toBe('active-composer')

    root.remove()
  })

  it('is null when every match is hidden', () => {
    const root = document.createElement('div')
    root.innerHTML = `<div ${PANE_HIDDEN_ATTR}><span class="composer"></span></div>`
    document.body.appendChild(root)

    expect(queryVisible('.composer', root)).toBeNull()

    root.remove()
  })
})

describe('queryAllVisible', () => {
  it('returns only the visible matches', () => {
    const root = stack()

    expect(root.querySelectorAll('.composer')).toHaveLength(2)
    expect(queryAllVisible('.composer', root).map(el => el.id)).toEqual(['active-composer'])

    root.remove()
  })
})

describe('hiddenPaneProps', () => {
  it('marks a hidden layer and leaves a visible one unmarked', () => {
    expect(hiddenPaneProps(true)).toEqual({ [PANE_HIDDEN_ATTR]: '' })
    // Empty, not `{ 'data-pane-hidden': 'false' }` — the selector is presence-based.
    expect(hiddenPaneProps(false)).toEqual({})
  })
})
