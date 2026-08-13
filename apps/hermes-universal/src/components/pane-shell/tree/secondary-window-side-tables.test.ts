/**
 * The layout's SIDE TABLES obey the same window-ownership rule as the tree
 * (MJXHRM-420).
 *
 * `persist()` has always stood a non-owning window down from writing the tree,
 * but dismissals, user-placed pins and the active-preset marker are separate
 * `localStorage` keys that the guard never reached — and every one of them is
 * written on a path such a window actually runs. `app/tile-window.tsx` and
 * `app/hud/hud-window.tsx` both side-effect-import `app/contrib/controller`,
 * which calls `bindTreeSideVisibility` during module evaluation, which calls
 * `setTreeSideCollapsed(side, false)`, which calls `restoreDismissedSidePanes`.
 *
 * So opening a detached tile — or summoning the HUD — un-dismissed every pane
 * the user had closed in the main window, in the store both windows share.
 *
 * The window flags are read once and cached, so each case re-imports the graph
 * against a fresh location.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const realLocation = window.location

function atSearch(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, search },
    writable: true
  })
}

const DISMISSED_KEY = 'hermes.layout.dismissedTiles.v1'
const USER_PLACED_KEY = 'hermes.layout.userPlacedTiles.v1'
const PRESET_KEY = 'hermes.layout.preset.active'

/** The layout the main window persisted, with `files` closed — the dismissal
 *  this test is about not losing. */
async function setup() {
  window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(['files']))

  const tree = await import('@/components/pane-shell/tree/store')
  const model = await import('@/components/pane-shell/tree/model')
  const { registerTiles } = await import('@/components/pane-shell/tile/registry')

  registerTiles([
    { id: 'workspace', kind: 'chat', title: 'Chat', render: () => null, placement: 'main' },
    { id: 'files', kind: 'files', title: 'Files', render: () => null, placement: 'left' }
  ])

  tree.declareDefaultTree(model.group(['workspace'], { id: 'grp-main' }))

  return tree
}

const storedDismissed = (): null | string[] => JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? 'null')

beforeEach(() => {
  window.localStorage.clear()
  vi.resetModules()
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation, writable: true })
  vi.resetModules()
})

describe('opening a side in a window that does not own the layout', () => {
  it('does not un-dismiss the main window`s closed panes on disk — tile window', async () => {
    atSearch('?win=tile&tile=session-tile:abc')

    const tree = await setup()

    tree.setTreeSideCollapsed('left', false)

    // The tile window's own view may forget the dismissal — it is showing one
    // tile, not the tree — but the shared record must survive it.
    expect(storedDismissed()).toEqual(['files'])
  })

  it('does not un-dismiss them from the HUD either', async () => {
    atSearch('?win=hud')

    const tree = await setup()

    tree.setTreeSideCollapsed('left', false)

    expect(storedDismissed()).toEqual(['files'])
  })

  it('DOES write it in the primary window, which owns the layout', async () => {
    atSearch('')

    const tree = await setup()

    tree.setTreeSideCollapsed('left', false)

    // Opening a side is an intent to SEE it, so the primary window really does
    // heal the stale dismissal — the control that stops the guard above from
    // passing by simply never writing.
    expect(storedDismissed()).toBeNull()
  })
})

describe('the other side tables', () => {
  it('withholds the preset marker and the user-placed pins from a tile window', async () => {
    atSearch('?win=tile&tile=terminal')

    const tree = await setup()
    const model = await import('@/components/pane-shell/tree/model')

    tree.applyTree(model.group(['workspace'], { id: 'grp-preset' }), 'focus')

    expect(window.localStorage.getItem(PRESET_KEY)).toBeNull()
    expect(window.localStorage.getItem(USER_PLACED_KEY)).toBeNull()
  })

  it('writes them in the primary window', async () => {
    atSearch('')

    const tree = await setup()
    const model = await import('@/components/pane-shell/tree/model')

    // A pin to clear, so the user-placed write has something to say. `files`
    // has to be in the tree for a move to be a real move, and it is dismissed
    // by `setup`, so re-declare a default that carries it.
    tree.declareDefaultTree(model.group(['workspace', 'files'], { id: 'grp-main' }))
    tree.moveTreePane('files', { groupId: 'grp-main', pos: 'right' })
    expect(JSON.parse(window.localStorage.getItem(USER_PLACED_KEY) ?? 'null')).toEqual(['files'])

    tree.applyTree(model.group(['workspace'], { id: 'grp-preset' }), 'focus')

    expect(window.localStorage.getItem(PRESET_KEY)).toBe('focus')
    // Picking a layout hands placement back to the app — the pin is cleared,
    // and the clear reaches disk.
    expect(window.localStorage.getItem(USER_PLACED_KEY)).toBeNull()
  })
})
