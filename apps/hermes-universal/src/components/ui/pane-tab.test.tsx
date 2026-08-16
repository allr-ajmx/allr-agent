import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PaneTab, type PaneTabCloseCounts, paneTabCloseSpecs, PaneTabLabel } from './pane-tab'

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

/**
 * THE SHARED CLOSE GROUP'S CONTRACT (MJXHRM-409).
 *
 * `paneTabCloseSpecs` is the one definition of the four close verbs — the whole
 * point of the ticket that introduced it and of the one that migrated the last
 * surfaces onto it. Its contract had no test at all: nothing pinned the verb
 * set, nothing pinned the ORDER, and nothing pinned the rule that makes the
 * primitive worth having.
 *
 * That rule is DISABLE, NEVER OMIT. The surfaces that hand-rolled this group
 * dropped a row that would close nothing, so the same right-click landed on a
 * different item depending on how many tabs happened to be open. Reverting to
 * that — the exact regression the migration existed to prevent — left the suite
 * green.
 */
describe('paneTabCloseSpecs', () => {
  const noop = () => {}

  const specs = (counts: PaneTabCloseCounts, onClose: (() => void) | undefined = noop) =>
    paneTabCloseSpecs({ counts, onClose, onCloseAll: noop, onCloseOthers: noop, onCloseToRight: noop })

  it('is four verbs in one fixed order, so the same row sits in the same place everywhere', () => {
    expect(specs({ all: 3, others: 2, right: 1 }).map(spec => spec.label)).toEqual([
      'Close',
      'Close others',
      'Close to the right',
      'Close all'
    ])
  })

  it('DISABLES a verb that would close nothing rather than dropping its row', () => {
    const lone = specs({ all: 1, others: 0, right: 0 })

    // Still four rows — the menu does not change shape with the tab count.
    expect(lone).toHaveLength(4)
    expect(lone.map(spec => Boolean(spec.disabled))).toEqual([false, true, true, false])
  })

  it('disables Close all too, on a strip whose only tab cannot be closed', () => {
    // `all` is the count of CLOSEABLE tabs, so it reaches zero on the lone
    // workspace tab — the one case where "Close all" really would do nothing.
    expect(specs({ all: 0, others: 0, right: 0 }).map(spec => Boolean(spec.disabled))).toEqual([
      false,
      true,
      true,
      true
    ])
  })

  it('omits Close ENTIRELY without a handler — an uncloseable tab shows no dead verb', () => {
    // The one row that is dropped rather than disabled, and the distinction is
    // deliberate: the other three are relative to this tab and still mean
    // something on a tab that cannot itself close.
    expect(
      paneTabCloseSpecs({
        counts: { all: 2, others: 1, right: 1 },
        onCloseAll: noop,
        onCloseOthers: noop,
        onCloseToRight: noop
      }).map(spec => spec.label)
    ).toEqual(['Close others', 'Close to the right', 'Close all'])
  })

  it('routes each row to its own callback', () => {
    const calls: string[] = []

    const rows = paneTabCloseSpecs({
      counts: { all: 3, others: 2, right: 1 },
      onClose: () => calls.push('close'),
      onCloseAll: () => calls.push('all'),
      onCloseOthers: () => calls.push('others'),
      onCloseToRight: () => calls.push('right')
    })

    rows.forEach(row => row.onSelect(new Event('select')))
    expect(calls).toEqual(['close', 'others', 'right', 'all'])
  })
})
