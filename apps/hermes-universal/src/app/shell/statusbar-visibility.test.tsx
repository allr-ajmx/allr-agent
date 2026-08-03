/**
 * The bar's right-click menu: which items it lists, what it can switch off, and
 * the one door that survives hiding the bar itself.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $statusbarHiddenIds,
  $statusbarVisible,
  setStatusbarItemVisible,
  STATUSBAR_HIDDEN_BY_DEFAULT,
  toggleStatusbarVisible
} from '@/store/statusbar-prefs'

import { StatusbarControls, type StatusbarItem } from './statusbar-controls'

const renderBar = (items: StatusbarItem[] = []) =>
  render(
    <MemoryRouter>
      <StatusbarControls items={items} />
    </MemoryRouter>
  )

// Radix needs both to open a context menu in jsdom.
const openContextMenu = (target: HTMLElement) => {
  fireEvent.pointerDown(target, { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(target, { button: 2 })
}

// Start each case from "everything shown" so a default-hidden id (cron, the
// timers) doesn't stand in for a user choice.
beforeEach(() => {
  $statusbarHiddenIds.set([])
})

afterEach(() => {
  $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
  $statusbarVisible.set(true)
})

describe('statusbar visibility', () => {
  it('hides an item the user switched off, and shows it again', () => {
    const items: StatusbarItem[] = [{ id: 'cron', label: 'Cron', toggleLabel: 'Cron', variant: 'action' }]

    const { rerender } = renderBar(items)

    expect(screen.getByText('Cron')).toBeInTheDocument()

    setStatusbarItemVisible('cron', false)
    rerender(
      <MemoryRouter>
        <StatusbarControls items={items} />
      </MemoryRouter>
    )

    expect(screen.queryByText('Cron')).not.toBeInTheDocument()
  })

  it('leaves an item with no toggleLabel alone — a plugin chip always shows', () => {
    // Same id as a hidden-by-default one, but it never opted into the menu.
    $statusbarHiddenIds.set(['plugin-chip'])
    renderBar([{ id: 'plugin-chip', label: 'Chip', variant: 'action' }])

    expect(screen.getByText('Chip')).toBeInTheDocument()
  })

  it('lists only opted-in items in the menu, and locks the ones that must stay', () => {
    renderBar([
      { id: 'cron', label: 'Cron', toggleLabel: 'Cron', variant: 'action' },
      { id: 'version-client', label: 'v1', lockedVisible: true, toggleLabel: 'Version & updates', variant: 'action' },
      { id: 'anon', label: 'Anon', variant: 'action' }
    ])

    openContextMenu(screen.getByRole('contentinfo'))

    expect(screen.getByText('Version & updates')).toBeInTheDocument()
    // Radix marks a disabled menu item with data-disabled, not the DOM property.
    expect(screen.getByRole('menuitemcheckbox', { name: /Version & updates/ })).toHaveAttribute('data-disabled')
    expect(screen.queryByRole('menuitemcheckbox', { name: /Anon/ })).not.toBeInTheDocument()
  })

  it('toggles the whole bar off and back on', () => {
    expect($statusbarVisible.get()).toBe(true)

    toggleStatusbarVisible()

    expect($statusbarVisible.get()).toBe(false)

    toggleStatusbarVisible()

    expect($statusbarVisible.get()).toBe(true)
  })

  it('keeps an emptied hidden set — turning everything on survives a reload', () => {
    for (const id of STATUSBAR_HIDDEN_BY_DEFAULT) {
      setStatusbarItemVisible(id, true)
    }

    expect($statusbarHiddenIds.get()).toEqual([])
  })
})
