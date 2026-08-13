/**
 * Profile share ACROSS WINDOW KINDS (MJXHRM-420).
 *
 * On Android the windowable surfaces open as a native screen Activity — a
 * separate WebView carrying `?win=activity` that shares this origin's
 * `localStorage` with the main window. That window does not own the persisted
 * layout (`ownsPersistedAppState()` is false there), and Profiles is one of the
 * surfaces it hosts, so the profile-share flows are the one place where an
 * activity window has to touch layout state at all:
 *
 *   • EXPORT reads the tree — and on Android the Profiles activity is the only
 *     door to it, so a blanked read ships an empty layout to the receiver.
 *   • IMPORT writes the tree — and it is the only layout write that is authored
 *     from OUTSIDE this window, so the ownership gate must not swallow it.
 *
 * These read `window.location.search` at MODULE LOAD (the window flags are
 * cached), so each case re-imports the whole graph against a fresh location.
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

const TREE_KEY = 'hermes.layout.tree.v2'
const PRESET_KEY = 'hermes.layout.preset.active'

/** A tree the receiver could not have invented for itself, so finding it on
 *  disk can only mean the import wrote it. */
const importedTree = {
  id: 'root',
  type: 'group' as const,
  panes: ['imported-pane'],
  active: 'imported-pane'
}

/** A tree standing in for what the user already had, so a dropped import is
 *  visible as "the old layout survived" rather than as an empty slate. */
const localTree = { id: 'root', type: 'group' as const, panes: ['chat'], active: 'chat' }

/** The pane ids of a root group node, whatever shape it arrived in — the tests
 *  only ever build single-group trees, so this is the whole layout. */
const panesOf = (node: unknown): string[] => (node as null | { panes?: string[] })?.panes ?? []

/**
 * Load `profile-share` with the network/dialog seams stubbed, in whatever window
 * the current `?win=` names. `desktop` is the overlay the fake archive carries.
 */
async function loadShare(desktop: unknown) {
  vi.doMock('@/lib/gateway-rest', () => ({
    exportProfileArchive: vi.fn().mockResolvedValue({ ok: true, archive: '/exports/work.tar.gz' }),
    importProfileArchive: vi.fn().mockResolvedValue({ ok: true, name: 'work', path: '/p/work', desktop })
  }))
  vi.doMock('@/lib/desktop-fs', () => ({ selectRemotePaths: vi.fn() }))
  vi.doMock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

  const share = await import('./profile-share')
  const rest = await import('@/lib/gateway-rest')
  const tree = await import('@/components/pane-shell/tree/store')

  return { rest, share, tree }
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation, writable: true })
  vi.doUnmock('@/lib/gateway-rest')
  vi.doUnmock('@/lib/desktop-fs')
  vi.doUnmock('@/store/notifications')
  vi.resetModules()
})

describe('export from the Android Profiles activity', () => {
  it('bundles the layout tree the main window persisted', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('?win=activity')

    const { rest, share } = await loadShare(null)

    await share.exportProfileBundle('work')

    const staged = JSON.parse(
      vi.mocked(rest.exportProfileArchive).mock.calls[0][1]?.extraFiles?.[share.DESKTOP_OVERLAY_FILENAME] ?? '{}'
    )

    // The read gate stays OPEN in an activity window: standing it down would
    // ship `layoutTree: null` from the only screen Android can export from.
    expect(panesOf(staged.layoutTree)).toEqual(['chat'])
  })

  it('ships no layout from a tile window, which holds none of its own', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('?win=tile&tile=terminal')

    const { rest, share } = await loadShare(null)

    await share.exportProfileBundle('work')

    const staged = JSON.parse(
      vi.mocked(rest.exportProfileArchive).mock.calls[0][1]?.extraFiles?.[share.DESKTOP_OVERLAY_FILENAME] ?? '{}'
    )

    expect(staged.layoutTree).toBeNull()
  })
})

describe('import from the Android Profiles activity', () => {
  it('PERSISTS the imported layout, not just the live atom', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('?win=activity')

    const { share, tree } = await loadShare({ version: 1, layoutTree: importedTree })

    await share.importProfileBundle('/tmp/work.tar.gz')

    // The sender's tree, with the receiver's own panes adopted into it —
    // applying a layout never loses a pane that is registered here.
    expect(panesOf(tree.$layoutTree.get())).toContain('imported-pane')
    // The half that used to be dropped: the atom took the new tree, the disk
    // kept the old one, and the next launch of the main window read the old one
    // back — after the same call had already cleared the user's pane sizes.
    expect(panesOf(JSON.parse(localStorage.getItem(TREE_KEY) ?? 'null'))).toContain('imported-pane')
  })

  it('marks the layout custom, so the picker does not claim a preset it is not on', async () => {
    atSearch('?win=activity')

    const { share } = await loadShare({ version: 1, layoutTree: importedTree })

    await share.importProfileBundle('/tmp/work.tar.gz')

    expect(localStorage.getItem(PRESET_KEY)).toBe('custom')
  })

  it('leaves the persisted layout alone when the bundled tree is junk', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('?win=activity')

    const { share } = await loadShare({ version: 1, layoutTree: { nope: true } })

    await share.importProfileBundle('/tmp/work.tar.gz')

    expect(panesOf(JSON.parse(localStorage.getItem(TREE_KEY) ?? 'null'))).toEqual(['chat'])
  })

  it('leaves the persisted layout alone when the archive carried no overlay', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('?win=activity')

    const { share } = await loadShare(null)

    await share.importProfileBundle('/tmp/work.tar.gz')

    expect(panesOf(JSON.parse(localStorage.getItem(TREE_KEY) ?? 'null'))).toEqual(['chat'])
    expect(localStorage.getItem(PRESET_KEY)).toBeNull()
  })
})

describe('the import handshake other windows watch', () => {
  it('a live primary window adopts a layout imported by another window', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    localStorage.setItem('hermes.paneStates.v1', JSON.stringify({ chat: { open: true, widthOverride: 420 } }))
    atSearch('')

    const { tree } = await loadShare(null)

    expect(panesOf(tree.$layoutTree.get())).toEqual(['chat'])

    // What the activity window's import leaves behind: the new tree, plus the
    // token bump that says "this was authored somewhere else".
    localStorage.setItem(TREE_KEY, JSON.stringify(importedTree))
    localStorage.setItem('hermes.layout.tree.imported', '7')
    window.dispatchEvent(new StorageEvent('storage', { key: 'hermes.layout.tree.imported', newValue: '7' }))

    expect(panesOf(tree.$layoutTree.get())).toEqual(['imported-pane'])
    // The importing window already cleared the size overrides on disk (a new
    // layout sizes itself). This window's stale copy has to go with them, or its
    // next pane change writes the old widths straight back over that.
    const panes = await import('@/store/panes')
    expect(panes.$paneStates.get()['chat']?.widthOverride).toBeUndefined()
  })

  it('adopts on coming back to the front, which is how Android delivers it', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('')

    const { tree } = await loadShare(null)

    // The import ran in a native Activity's own WebView. Whether a `storage`
    // event crosses that boundary is not something this app can promise —
    // finishing the Activity turning the main window `visible` again is.
    localStorage.setItem(TREE_KEY, JSON.stringify(importedTree))
    localStorage.setItem('hermes.layout.tree.imported', '7')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(panesOf(tree.$layoutTree.get())).toEqual(['imported-pane'])
  })

  it('does not replay a token it has already accounted for', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    // An import from an earlier run of the app: the token outlives the process,
    // so a window that treated "a token exists" as "a layout just arrived" would
    // re-adopt on every single focus — and clear the user's pane sizes each time.
    localStorage.setItem('hermes.layout.tree.imported', '7')
    atSearch('')

    const { tree } = await loadShare(null)

    localStorage.setItem(TREE_KEY, JSON.stringify(importedTree))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new StorageEvent('storage', { key: 'hermes.layout.tree.imported', newValue: '7' }))

    expect(panesOf(tree.$layoutTree.get())).toEqual(['chat'])
  })

  it('ignores an ordinary layout write by another window — only an import claims the tree', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('')

    const { tree } = await loadShare(null)

    // A second desktop instance committing its own tree. No token bump, so this
    // window keeps the layout the user arranged in it.
    localStorage.setItem(TREE_KEY, JSON.stringify(importedTree))
    window.dispatchEvent(new StorageEvent('storage', { key: TREE_KEY, newValue: 'x' }))

    expect(panesOf(tree.$layoutTree.get())).toEqual(['chat'])
  })

  it('a tile window does not adopt an imported layout — it renders one tile, not a tree', async () => {
    localStorage.setItem(TREE_KEY, JSON.stringify(localTree))
    atSearch('?win=tile&tile=terminal')

    const { tree } = await loadShare(null)

    expect(tree.$layoutTree.get()).toBeNull()

    localStorage.setItem(TREE_KEY, JSON.stringify(importedTree))
    localStorage.setItem('hermes.layout.tree.imported', '7')
    window.dispatchEvent(new StorageEvent('storage', { key: 'hermes.layout.tree.imported', newValue: '7' }))

    expect(tree.$layoutTree.get()).toBeNull()
  })
})
