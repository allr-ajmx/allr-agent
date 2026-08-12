import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PaneTab, PaneTabLabel } from './pane-tab'

afterEach(cleanup)

describe('PaneTab close gestures', () => {
  it('middle-click closes — pointer events only, no auxclick', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    const tab = screen.getByText('tab')
    fireEvent.pointerDown(tab, { button: 1 })
    fireEvent.pointerUp(tab, { button: 1 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('⌘-click (metaKey + button 0) closes — the Mac middle-click equivalent', () => {
    const onClose = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('⌘-click preempts the shell drag/activate pointerdown handler', () => {
    const onClose = vi.fn()
    const onPointerDown = vi.fn()
    render(
      <PaneTab onClose={onClose} onPointerDown={onPointerDown}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it('⌘-click swallows the follow-up activation click (capture phase)', () => {
    const onClose = vi.fn()
    const onActivate = vi.fn()
    render(
      <PaneTab onClose={onClose}>
        <PaneTabLabel as="button" onClick={onActivate}>
          tab
        </PaneTabLabel>
      </PaneTab>
    )

    fireEvent.click(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('plain left-click neither closes nor blocks activation', () => {
    const onClose = vi.fn()
    const onActivate = vi.fn()
    const onPointerDown = vi.fn()
    render(
      <PaneTab onClose={onClose} onPointerDown={onPointerDown}>
        <PaneTabLabel as="button" onClick={onActivate}>
          tab
        </PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0 })
    fireEvent.click(screen.getByText('tab'), { button: 0 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onPointerDown).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('does nothing without an onClose (uncloseable workspace tab)', () => {
    const onPointerDown = vi.fn()
    render(
      <PaneTab onPointerDown={onPointerDown}>
        <PaneTabLabel>tab</PaneTabLabel>
      </PaneTab>
    )

    fireEvent.pointerDown(screen.getByText('tab'), { button: 0, metaKey: true })
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  // The strip's own background is not a tab: its gaps, its trailing chrome and
  // the rail's list all sit outside every `middleClickHandlers` element. A press
  // that starts there must not be able to spend an arm an earlier, abandoned
  // press left behind. Asserted through the SHELL, not the helper, because the
  // shell is what every tree tab in the app actually renders.
  it('a press starting on the strip cannot close the tab it releases over', () => {
    const onClose = vi.fn()
    render(
      <div data-testid="strip">
        <PaneTab onClose={onClose}>
          <PaneTabLabel>tab</PaneTabLabel>
        </PaneTab>
      </div>
    )

    const tab = screen.getByText('tab')
    const strip = screen.getByTestId('strip')

    // Press the tab, change your mind, release clear of it.
    fireEvent.pointerDown(tab, { button: 1 })
    fireEvent.pointerUp(strip, { button: 1 })
    expect(onClose).not.toHaveBeenCalled()

    // A fresh gesture off the tab that happens to end on it.
    fireEvent.pointerDown(strip, { button: 1 })
    fireEvent.pointerUp(tab, { button: 1 })
    expect(onClose).not.toHaveBeenCalled()
  })
})
