import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { FileSearchHit } from '@/lib/file-search'
import { IS_MOBILE } from '@/lib/platform'
import { $folderDownloadAvailable } from '@/store/downloads'
import { $workspaceCwd, $workspaceHome } from '@/store/workspace-events'

import { RightSidebarPane } from './index'

const CWD = '/repo'

const hits = vi.hoisted(() => ({ value: [] as FileSearchHit[] }))
const setExplorerPath = vi.hoisted(() => vi.fn())

// The one action every folder pick goes through (`store/explorer-path`). Mocked
// so this file can assert the BUTTON is wired to it without dragging the
// gateway client in; what the action then does is that module's own test.
vi.mock('@/store/explorer-path', () => ({ setExplorerPath }))

// The gateway's ranked answer, stubbed. This file is about what a result ROW
// offers on right-click, not about how the hits were found — `use-file-search`
// and `lib/file-search` own that and test it themselves.
vi.mock('./files/use-file-search', () => ({
  useFileSearch: () => ({ available: true, hits: hits.value, loading: false, source: 'server' })
}))

// Same reason: no `/api/fs` round-trip for a pane whose tree is not under test.
vi.mock('./files/use-project-tree', () => ({
  useProjectTree: (cwd: string) => ({
    collapseAll: () => {},
    collapseNonce: 0,
    data: [],
    effectiveCwd: cwd,
    loadChildren: () => {},
    openState: {},
    refreshRoot: async () => {},
    rootError: null,
    rootLoading: false,
    setNodeOpen: () => {}
  })
}))

const FILE_HIT: FileSearchHit = { isDirectory: false, name: 'notes.md', path: '/repo/docs/notes.md', rank: 1 }
const FOLDER_HIT: FileSearchHit = { isDirectory: true, name: 'docs', path: '/repo/docs', rank: 2 }

function renderPane() {
  return render(
    <I18nProvider>
      <RightSidebarPane onActivateFile={() => {}} onActivateFolder={() => {}} />
    </I18nProvider>
  )
}

/** Put the pane into its search view: the results replace the tree only while
 *  the box has a query in it. */
function search(term: string) {
  const box = screen.getByLabelText('Search files')

  fireEvent.change(box, { target: { value: term } })
}

function menuItem(name: string): HTMLElement | null {
  return screen.queryByRole('menuitem', { name })
}

beforeEach(() => {
  hits.value = []
  setExplorerPath.mockClear()
  $workspaceCwd.set(CWD)
  $workspaceHome.set('')
  $folderDownloadAvailable.set(null)
})

afterEach(() => {
  cleanup()
  $workspaceCwd.set('')
  $workspaceHome.set('')
  $folderDownloadAvailable.set(null)
})

describe('the Home button', () => {
  it('routes through the one folder-pick action instead of re-rooting the view', () => {
    // The bug this closes: Home used to set a view-only tree root that beat
    // `$effectiveCwd` outright, so the tree moved and the session did not — and
    // while that root was set, a real cwd change could not show through it
    // either. Home is now the same gesture as every other folder pick.
    $workspaceHome.set('/home/gateway')
    renderPane()

    fireEvent.click(screen.getByLabelText('Go to home folder'))

    expect(setExplorerPath).toHaveBeenCalledWith('/home/gateway')
  })

  it('is not rendered at all when the gateway reported no home', () => {
    // `home` is ADDITIVE on `/api/fs/default-cwd`; an older backend omits it,
    // and a button that would root the tree at '' is worse than no button.
    renderPane()

    expect(screen.queryByLabelText('Go to home folder')).toBeNull()
  })
})

describe('search-result rows', () => {
  // Same guard as the tree's: no right-click trigger is rendered on a phone, so
  // every assertion below would pass vacuously on a mis-sniffed desktop.
  it('runs on the desktop branch', () => {
    expect(IS_MOBILE).toBe(false)
  })

  it('opens the same menu as the tree on a right-click', () => {
    hits.value = [FILE_HIT]
    renderPane()
    search('notes')

    fireEvent.contextMenu(screen.getByText('notes.md'))

    expect(menuItem('Copy Path')).toBeTruthy()
    // Present only because the row is given `relativeTo={cwd}`.
    expect(menuItem('Copy Relative Path')).toBeTruthy()
    expect(menuItem('Download')).toBeTruthy()
  })

  it('offers the folder-only rows for a folder hit and not for a file hit', () => {
    hits.value = [FILE_HIT]
    renderPane()
    search('notes')

    fireEvent.contextMenu(screen.getByText('notes.md'))
    expect(menuItem('Open Folder Here')).toBeNull()
    expect(menuItem('Set as Project Folder')).toBeNull()
    expect(menuItem('Download folder as zip')).toBeNull()

    cleanup()

    hits.value = [FOLDER_HIT]
    renderPane()
    search('docs')

    fireEvent.contextMenu(screen.getByText('docs'))
    expect(menuItem('Open Folder Here')).toBeTruthy()
    expect(menuItem('Set as Project Folder')).toBeTruthy()
    expect(menuItem('Download folder as zip')).toBeTruthy()
  })

  it('drops the folder download row when the gateway has no archive route', () => {
    $folderDownloadAvailable.set(false)
    hits.value = [FOLDER_HIT]
    renderPane()
    search('docs')

    fireEvent.contextMenu(screen.getByText('docs'))

    expect(menuItem('Set as Project Folder')).toBeTruthy()
    expect(menuItem('Download folder as zip')).toBeNull()
  })

  // #4: a search hit and a tree row are the same object seen two ways, so they
  // read at the same size. `files/tree.tsx` sets the tree row's.
  it('sizes result rows the way tree rows are sized', () => {
    hits.value = [FILE_HIT]
    renderPane()
    search('notes')

    const row = screen.getByRole('option')

    expect(row.className).toContain(IS_MOBILE ? 'text-sm' : 'text-xs')
    expect(row.className).not.toContain('text-sm text-foreground')
    expect(screen.getByText('notes.md').className).not.toContain('text-sm')
  })
})
