import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isMetaClose, middleClickHandlers } from './middle-click'

afterEach(cleanup)

/** A middle click as a real three-button mouse delivers it. Windows and Linux
 *  swallow the trailing `auxclick` when the press starts autoscroll, so the
 *  gesture may NOT depend on that event. */
function middleClick(element: Element, upOn: Element = element) {
  fireEvent.mouseDown(element, { button: 1 })
  fireEvent.pointerDown(element, { button: 1 })
  fireEvent.pointerUp(upOn, { button: 1 })
}

function Target({ action, id = 'target' }: { action?: () => void; id?: string }) {
  return (
    <button {...middleClickHandlers(action)} id={id} type="button">
      {id}
    </button>
  )
}

describe('isMetaClose', () => {
  it('is the trackpad stand-in for the middle button: ⌘ + primary only', () => {
    expect(isMetaClose({ button: 0, metaKey: true })).toBe(true)
    // A plain left click activates/drags; ⌘ is what separates them.
    expect(isMetaClose({ button: 0, metaKey: false })).toBe(false)
    // The middle button already has its own path — this must not double-fire it.
    expect(isMetaClose({ button: 1, metaKey: true })).toBe(false)
    // ⌃-click is the macOS context menu, not a close.
    expect(isMetaClose({ button: 2, metaKey: true })).toBe(false)
  })
})

describe('middleClickHandlers', () => {
  it('fires without an auxclick — the event that never arrives when autoscroll starts', () => {
    const action = vi.fn()
    render(<Target action={action} />)

    middleClick(screen.getByText('target'))
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('cancels mousedown so the autoscroll pan widget never appears', () => {
    render(<Target action={vi.fn()} />)

    const down = fireEvent.mouseDown(screen.getByText('target'), { button: 1 })
    expect(down).toBe(false) // preventDefault() called
  })

  it('cancels the middle mousedown even with no action — the surface owns the button', () => {
    render(<Target />)

    expect(fireEvent.mouseDown(screen.getByText('target'), { button: 1 })).toBe(false)
  })

  it('leaves the left and right buttons to their own handlers', () => {
    const action = vi.fn()
    render(<Target action={action} />)

    const target = screen.getByText('target')
    fireEvent.pointerDown(target, { button: 0 })
    fireEvent.pointerUp(target, { button: 0 })
    fireEvent.pointerDown(target, { button: 2 })
    fireEvent.pointerUp(target, { button: 2 })
    expect(action).not.toHaveBeenCalled()

    // A non-middle mousedown keeps its default (text selection, drag start).
    expect(fireEvent.mouseDown(target, { button: 0 })).toBe(true)
  })

  it('does nothing when the release lands on a different element', () => {
    const pressed = vi.fn()
    const released = vi.fn()
    render(
      <>
        <Target action={pressed} id="pressed" />
        <Target action={released} id="released" />
      </>
    )

    middleClick(screen.getByText('pressed'), screen.getByText('released'))
    expect(pressed).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
  })

  it('a press with no action cannot arm the NEXT element it releases over', () => {
    const action = vi.fn()
    render(
      <>
        <Target id="inert" />
        <Target action={action} id="live" />
      </>
    )

    middleClick(screen.getByText('inert'), screen.getByText('live'))
    expect(action).not.toHaveBeenCalled()
  })

  it('a press abandoned OFF the gesture surface cannot be spent by a later release', () => {
    const action = vi.fn()
    render(
      <div data-testid="strip">
        <Target action={action} id="live" />
      </div>
    )

    const live = screen.getByText('live')
    const strip = screen.getByTestId('strip')

    // Press the tab, slide off it, let go somewhere that owns no gesture — the
    // press is abandoned and the strip never sees the release.
    fireEvent.mouseDown(live, { button: 1 })
    fireEvent.pointerDown(live, { button: 1 })
    fireEvent.pointerUp(strip, { button: 1 })
    expect(action).not.toHaveBeenCalled()

    // A SECOND gesture that starts on the strip's own background — the gaps
    // between tabs, the terminal rail's list, the sidebar's empty space — and
    // ends over the tab. It never pressed the tab, so it must not close it.
    fireEvent.mouseDown(strip, { button: 1 })
    fireEvent.pointerDown(strip, { button: 1 })
    fireEvent.pointerUp(live, { button: 1 })
    expect(action).not.toHaveBeenCalled()
  })

  it('disarms when the pointer is cancelled mid-press (a scroll or drag takes over)', () => {
    const action = vi.fn()
    render(<Target action={action} />)

    const target = screen.getByText('target')
    fireEvent.mouseDown(target, { button: 1 })
    fireEvent.pointerDown(target, { button: 1 })
    fireEvent.pointerCancel(target, { button: 1 })
    fireEvent.pointerUp(target, { button: 1 })
    expect(action).not.toHaveBeenCalled()
  })

  it('still fires the gesture that follows an abandoned one', () => {
    const action = vi.fn()
    render(<Target action={action} />)

    const target = screen.getByText('target')
    fireEvent.mouseDown(target, { button: 1 })
    fireEvent.pointerDown(target, { button: 1 })
    // ...released off-target, never seen here.

    middleClick(target)
    expect(action).toHaveBeenCalledTimes(1)
  })
})
