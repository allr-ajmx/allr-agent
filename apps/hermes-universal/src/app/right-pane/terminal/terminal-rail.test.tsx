/**
 * The terminal rail's close GESTURES, at the rail.
 *
 * `store/terminals.test.ts` covers the verbs. Nothing covered the rail calling
 * them: deleting the middle-click outright left every terminal, session and
 * tree test green. This is the surface where that matters most — the rail has
 * no ✕, and closing a terminal takes a live shell with it, with no confirm gate
 * on any path.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function setup() {
  const terminals = await import('@/store/terminals')
  const { TerminalRail } = await import('./terminal-rail')

  terminals.closeAllTerminals()
  terminals.createTerminal()
  terminals.createTerminal()

  render(<TerminalRail />)

  return terminals
}

const ids = (t: { $terminals: { get: () => { id: string }[] } }) => t.$terminals.get().map(term => term.id)

/** No `auxclick`: this rail is a scroller, and the pan that a middle press
 *  starts there eats the event on every platform but macOS. */
function middleClick(element: Element) {
  fireEvent.mouseDown(element, { button: 1 })
  fireEvent.pointerDown(element, { button: 1 })
  fireEvent.pointerUp(element, { button: 1 })
}

const tabs = () => screen.getAllByRole('tab')

beforeEach(() => {
  window.localStorage.clear()
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.resetModules()
})

describe('terminal rail close gestures', () => {
  it('middle-click closes that terminal and leaves the other alone', async () => {
    const terminals = await setup()
    const [first, second] = ids(terminals)

    middleClick(tabs()[0])
    expect(ids(terminals)).toEqual([second])
    expect(first).not.toBe(second)
  })

  it('cancels the middle mousedown so no autoscroll pan starts over the rail', async () => {
    await setup()

    expect(fireEvent.mouseDown(tabs()[0], { button: 1 })).toBe(false)
  })

  it('⌘-click closes too — the trackpad stand-in for the middle button', async () => {
    const terminals = await setup()
    const [, second] = ids(terminals)

    fireEvent.click(tabs()[0], { button: 0, metaKey: true })
    expect(ids(terminals)).toEqual([second])
  })

  it('a plain click selects rather than closes', async () => {
    const terminals = await setup()
    const [first] = ids(terminals)

    fireEvent.click(tabs()[0])
    expect(terminals.$activeTerminalId.get()).toBe(first)
    expect(ids(terminals)).toHaveLength(2)
  })
})

/**
 * The rail's MENU, which nothing rendered either.
 *
 * The four verbs and their enablement come from `paneTabCloseItems` +
 * `terminalCloseTargets`, both covered on their own — but nothing held the rail
 * WIRING them, nor Hide's position. Hide is a verb about the RAIL, not about a
 * terminal, so it sits below the separator; folded into the close group it
 * would read as a fifth way to close one.
 */
describe('terminal rail context menu', () => {
  const openOn = (element: Element) => {
    fireEvent.pointerDown(element, { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(element, { button: 2 })
  }

  const rows = () => screen.getAllByRole('menuitem')

  it('offers the four shared close verbs, then Hide below the separator', async () => {
    await setup()

    openOn(tabs()[0])
    expect(rows().map(row => row.textContent)).toEqual([
      'Close',
      'Close others',
      'Close to the right',
      'Close all',
      'Hide terminal'
    ])

    // And the rule is the SEPARATOR, not merely the position: Hide is a verb
    // about the rail, so it must be visually cut off from the four that are
    // about this terminal rather than reading as a fifth way to close one.
    const hide = screen.getByRole('menuitem', { name: 'Hide terminal' })
    expect(hide.previousElementSibling?.getAttribute('role')).toBe('separator')
  })

  it('acts on the terminal the menu was opened on, and only to its right', async () => {
    const terminals = await setup()
    terminals.createTerminal()

    const [first, second] = ids(terminals)

    // THREE terminals, menu on the MIDDLE one: "to the right" leaves two and
    // "others" would leave one, so the two verbs are distinguishable — with a
    // pair they close the same set and either wiring passes.
    openOn(tabs()[1])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close to the right' }))
    expect(ids(terminals)).toEqual([first, second])
  })

  it('greys the verbs that would close nothing rather than dropping their rows', async () => {
    const terminals = await setup()
    terminals.closeTerminal(ids(terminals)[1])

    openOn(tabs()[0])

    const state = Object.fromEntries(rows().map(row => [row.textContent, row.getAttribute('data-disabled') !== null]))
    expect(state['Close others']).toBe(true)
    expect(state['Close to the right']).toBe(true)
    // Close all still bites: there is one terminal and it is closeable.
    expect(state['Close all']).toBe(false)
  })
})
