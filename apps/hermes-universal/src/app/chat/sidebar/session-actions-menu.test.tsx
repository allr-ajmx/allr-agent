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

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The drawer half of this menu only exists on a phone, and the suite runs in
// jsdom — so the flag is a getter the mobile block can flip. It stays FALSE for
// every test above, which is the desktop menu those tests are about.
const { mobile } = vi.hoisted(() => ({ mobile: { value: false } }))

vi.mock('@/lib/platform', async importOriginal => ({
  ...((await importOriginal()) as Record<string, unknown>),
  get IS_MOBILE() {
    return mobile.value
  }
}))

import type { PaneTabCloseItemsOptions } from '@/components/ui/pane-tab'
import { LONG_PRESS_MS } from '@/lib/long-press'
import { IS_MOBILE } from '@/lib/platform'
import { $activeStoredSessionId, $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { SessionActionsMenu, SessionContextMenu, sessionMenuClaimedPress } from './session-actions-menu'

afterEach(cleanup)

const CLOSE_GROUP = ['Close', 'Close others', 'Close to the right', 'Close all']

const openMenu = (tab?: { close: PaneTabCloseItemsOptions; onReload: () => void }, sessionId = 'sess-1') => {
  render(
    <SessionContextMenu
      onArchive={() => {}}
      onDelete={() => {}}
      onPin={() => {}}
      sessionId={sessionId}
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

/**
 * MJXHRM-423 — "Open in tile" is about a CONVERSATION.
 *
 * A tile tab's menu is handed the key its tile was opened with, and
 * auto-compression rotates the id main is holding for the same chat. Compared as
 * strings the row was offered on the session already on screen, where
 * `openSessionTile` no-ops — a menu row that does nothing when picked.
 */
describe('the session menu on the chat already in main', () => {
  afterEach(() => {
    $sessions.set([])
    $activeStoredSessionId.set(null)
  })

  const OPEN_HERE = IS_MOBILE ? 'Open in bubble' : 'Open in tile'

  it('offers the open verb for a different conversation', () => {
    $activeStoredSessionId.set('other')

    openMenu()

    expect(items()).toContain(OPEN_HERE)
  })

  it('withholds it when main holds the same conversation under its live tip', () => {
    $sessions.set([{ _lineage_root_id: 'root', id: 'tip' } as SessionInfo])
    $activeStoredSessionId.set('tip')

    openMenu(undefined, 'root')

    expect(items()).not.toContain(OPEN_HERE)
  })
})

/**
 * ALLR-37 — a submenu's `contentClassName` has to survive the DRAWER.
 *
 * On touch this menu is rendered with a third kit: submenus become pages in a
 * top drawer rather than hover panels. The Appearance spec declares the padding
 * its swatch grid needs (`contentClassName: 'p-2'`) and both Radix kits put it
 * on the floating panel — but the drawer kit used to push only the content's
 * CHILDREN, so the class was dropped. Drawer rows carry their own `px-4` and a
 * custom body carries none, which left the grid flush against both edges of a
 * panel that clips rather than scrolls.
 */
describe('the session menu as a mobile DRAWER', () => {
  beforeEach(() => {
    mobile.value = true
  })

  afterEach(() => {
    mobile.value = false
  })

  const openAppearance = () => {
    render(
      <SessionActionsMenu
        onArchive={() => {}}
        onDelete={() => {}}
        onPin={() => {}}
        sessionId="sess-1"
        title="Some chat"
      >
        <button type="button">kebab</button>
      </SessionActionsMenu>
    )

    fireEvent.click(screen.getByText('kebab'))
    fireEvent.click(screen.getByText('Appearance'))
  }

  it('renders the submenu as a page rather than a nested panel', () => {
    openAppearance()

    expect(document.querySelector('[data-top-drawer]')).not.toBeNull()
    expect(document.querySelector('.grid-cols-6')).not.toBeNull()
  })

  it('carries the spec’s contentClassName onto the page it pushes', () => {
    openAppearance()

    // The grid itself is unpadded — the padding is the SUBMENU's, declared by
    // the spec, and on this flavour the page is what stands for the submenu.
    expect(document.querySelector('.grid-cols-6')?.closest('.p-2')).not.toBeNull()
  })
})

/**
 * ALLR-39 — a LONG PRESS opens the drawer, not the desktop menu.
 *
 * `SessionContextMenu` had no `IS_MOBILE` branch at all, so on touch Radix's own
 * `ContextMenuTrigger` armed a ~700ms press and popped the floating `w-40` panel
 * — a menu whose submenus open on a hover a finger does not have.
 *
 * The trap is the DOUBLE WRAP: a row is inside both wrappers, so the naive fix
 * gives it two drawers with two open states. The outer one owns the drawer and
 * the kebab defers to it, which is what these hold.
 */
describe('a long press on a session row', () => {
  beforeEach(() => {
    mobile.value = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    mobile.value = false
  })

  // The row as it is actually assembled: the context menu wraps everything, the
  // kebab's own menu wraps the button inside it (session-row.tsx:151/180).
  const renderRow = () => {
    const actions = {
      onArchive: () => {},
      onDelete: () => {},
      onPin: () => {},
      sessionId: 'sess-1',
      title: 'Some chat'
    }

    render(
      <SessionContextMenu {...actions}>
        <div>
          <span>row</span>
          <SessionActionsMenu {...actions}>
            <button type="button">kebab</button>
          </SessionActionsMenu>
        </div>
      </SessionContextMenu>
    )
  }

  const holdRow = () => {
    const target = screen.getByText('row')

    fireEvent.pointerDown(target, { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS))
    fireEvent.pointerUp(target, { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
  }

  const drawers = () => document.querySelectorAll('[data-top-drawer]')

  it('opens the drawer, not the floating desktop menu', () => {
    renderRow()
    holdRow()

    expect(drawers()).toHaveLength(1)
    expect(screen.getByText('Rename')).toBeTruthy()
  })

  it('opens the SAME drawer the kebab does — one panel, never two', () => {
    renderRow()
    holdRow()
    // The other gesture, on the same row, while the first drawer is up.
    fireEvent.click(screen.getByText('kebab'))

    expect(drawers()).toHaveLength(1)
    // One item list, not two stacked copies of it.
    expect(screen.getAllByText('Rename')).toHaveLength(1)
  })

  it('claims the press, so the row does not also resume the session', () => {
    renderRow()

    // A press that never reaches the threshold is an ordinary tap and stays the
    // row's — this is the flag session-row.tsx reads from `onTap` and `onClick`.
    fireEvent.pointerDown(screen.getByText('row'), { button: 0, clientX: 5, clientY: 5, pointerType: 'touch' })
    expect(sessionMenuClaimedPress()).toBe(false)

    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(sessionMenuClaimedPress()).toBe(true)
  })
})
