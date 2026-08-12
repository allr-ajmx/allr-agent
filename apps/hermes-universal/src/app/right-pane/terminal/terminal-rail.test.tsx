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
