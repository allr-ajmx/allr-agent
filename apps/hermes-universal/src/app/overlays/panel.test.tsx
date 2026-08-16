/**
 * Panel row actions: one `menuItems` array has to drive BOTH the hover kebab and
 * the row's right-click menu, or the two surfaces drift (MJXHRM-50).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { PanelListRow, PanelRowMenu } from './panel'

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.setPointerCapture ??= () => undefined
  HTMLElement.prototype.scrollIntoView ??= () => undefined
})

// Radix needs both to open a context menu in jsdom.
const openContextMenu = (target: HTMLElement) => {
  fireEvent.pointerDown(target, { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(target, { button: 2 })
}

afterEach(() => {
  cleanup()
})

describe('PanelRowMenu', () => {
  it('opens its actions menu from the kebab', async () => {
    const onSelect = vi.fn()

    render(<PanelRowMenu items={[{ label: 'Rename', onSelect }]} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions' }), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('renders nothing when a row has no actions', () => {
    const { container } = render(<PanelRowMenu items={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  // The kebab hides until the row is hovered — and a finger never hovers, so
  // `coarse:` is the entire reason a phone can reach a panel row's actions
  // (cron and profiles are phone surfaces). Dropping it was invisible to every
  // test in the repo, which is the shape of the bug MJXHRM-377 filed against the
  // sidebar row.
  it('stays visible on a coarse pointer, which has no hover to reveal it', () => {
    render(<PanelRowMenu items={[{ label: 'Rename', onSelect: () => undefined }]} />)

    const classes = screen.getByRole('button', { name: 'Actions' }).className.split(/\s+/)

    expect(classes).toContain('opacity-0')
    expect(classes).toContain('coarse:opacity-100')
  })
})

describe('PanelListRow menuItems', () => {
  it('answers right-click with the same actions as the kebab', async () => {
    const onSelect = vi.fn()

    render(
      <PanelListRow
        active={false}
        menuItems={[{ icon: 'trash', label: 'Delete', onSelect, tone: 'danger' }]}
        menuLabel="Job actions"
        onSelect={() => undefined}
        title="Nightly digest"
      />
    )

    // Kebab and right-click both reach the item, and the danger tone survives
    // the bridge into the shared actions-menu kit.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Job actions' }), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    expect(onSelect).toHaveBeenCalledOnce()

    openContextMenu(screen.getByText('Nightly digest'))

    const item = await screen.findByRole('menuitem', { name: 'Delete' })
    expect(item).toHaveAttribute('data-variant', 'destructive')

    fireEvent.click(item)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('leaves a row with no actions bare — no kebab, no right-click menu', () => {
    render(<PanelListRow active={false} menuItems={[]} onSelect={() => undefined} title="Default" />)

    expect(screen.queryByRole('button', { name: 'Actions' })).not.toBeInTheDocument()

    openContextMenu(screen.getByText('Default'))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
