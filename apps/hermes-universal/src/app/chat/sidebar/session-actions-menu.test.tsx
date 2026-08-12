/**
 * THE SESSION MENU IS TWO MENUS (MJXHRM-409).
 *
 * The same component serves a SIDEBAR ROW and a TAB, and the tab verbs are the
 * only difference between them. That split was the reason this file hand-rolled
 * its own copy of the four close verbs — it is assembled from a SPEC LIST, and
 * the shared primitive only returned JSX until #118 split it into
 * `paneTabCloseSpecs` (data) + `paneTabCloseItems` (that data rendered).
 *
 * Nothing rendered this menu in any test. So neither half of what the migration
 * changed was held: that a row menu still grows no Close it cannot honour, and
 * that a tab menu ends with Reload plus the four shared verbs in the shared
 * order, DISABLED rather than dropped when they would close nothing.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PaneTabCloseItemsOptions } from '@/components/ui/pane-tab'

import { SessionContextMenu } from './session-actions-menu'

afterEach(cleanup)

const CLOSE_GROUP = ['Close', 'Close others', 'Close to the right', 'Close all']

const openMenu = (tab?: { close: PaneTabCloseItemsOptions; onReload: () => void }) => {
  render(
    <SessionContextMenu
      onArchive={() => {}}
      onDelete={() => {}}
      onPin={() => {}}
      sessionId="sess-1"
      tab={tab}
      title="Some chat"
    >
      <div>row</div>
    </SessionContextMenu>
  )

  const target = screen.getByText('row')
  fireEvent.pointerDown(target, { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(target, { button: 2 })
}

const items = () => screen.getAllByRole('menuitem').map(item => item.textContent)

const tabVerbs = (counts: PaneTabCloseItemsOptions['counts'], spies: Partial<PaneTabCloseItemsOptions> = {}) => ({
  close: {
    counts,
    onClose: () => {},
    onCloseAll: () => {},
    onCloseOthers: () => {},
    onCloseToRight: () => {},
    ...spies
  },
  onReload: () => {}
})

describe('the session menu on a sidebar ROW', () => {
  it('offers no close verbs — a row is not a tab and has nothing to close', () => {
    openMenu()

    // The row's own verbs are all there, and Delete is still the last of them.
    const labels = items()
    expect(labels).toContain('Rename')
    expect(labels.at(-1)).toBe('Delete')

    // And nothing a row cannot honour was appended after them.
    for (const verb of [...CLOSE_GROUP, 'Reload']) {
      expect(labels).not.toContain(verb)
    }
  })
})

describe('the session menu on a TAB', () => {
  it('ends with Reload and the four shared close verbs, in the shared order', () => {
    openMenu(tabVerbs({ all: 3, others: 2, right: 1 }))

    // The tail, not the whole list: the session verbs above it are this menu's
    // own business, but the close group must read the same as every other tab
    // strip's — same rows, same order, same place.
    expect(items().slice(-5)).toEqual(['Reload', ...CLOSE_GROUP])
  })

  it('DISABLES the verbs that would close nothing instead of dropping their rows', () => {
    // A lone closeable tab. Before the migration this menu omitted the dead
    // rows, so the same right-click landed on a different item depending on how
    // many tabs happened to be open.
    openMenu(tabVerbs({ all: 1, others: 0, right: 0 }))

    const rows = screen.getAllByRole('menuitem')

    const state = Object.fromEntries(
      rows.map(row => [row.textContent, row.getAttribute('data-disabled') !== null || row.ariaDisabled === 'true'])
    )

    expect(rows.map(row => row.textContent).slice(-5)).toEqual(['Reload', ...CLOSE_GROUP])
    expect(state.Close).toBe(false)
    expect(state['Close others']).toBe(true)
    expect(state['Close to the right']).toBe(true)
    expect(state['Close all']).toBe(false)
  })

  it('runs the verb the row names', () => {
    const onCloseOthers = vi.fn()
    openMenu(tabVerbs({ all: 3, others: 2, right: 1 }, { onCloseOthers }))

    fireEvent.click(screen.getByRole('menuitem', { name: 'Close others' }))
    expect(onCloseOthers).toHaveBeenCalledTimes(1)
  })
})
