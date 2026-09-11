import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTEXT_KIT, DROPDOWN_KIT, type MenuKit } from '@/components/ui/actions-menu'
import { $folderDownloadAvailable } from '@/store/downloads'

import { fileEntryMenuItems, type FileEntryTarget } from './file-actions'

const remote = vi.hoisted(() => ({ value: false }))

vi.mock('@/lib/desktop-fs', () => ({ isDesktopFsRemoteMode: () => remote.value }))

const COPY = {
  actions: 'File actions',
  copyPath: 'Copy Path',
  copyRelativePath: 'Copy Relative Path',
  delete: 'Delete',
  deleteBody: 'body',
  deleteTitle: (name: string) => `Delete ${name}?`,
  download: 'Download',
  pathCopied: 'Path copied',
  rename: 'Rename…',
  renameLabel: 'New name',
  openFolderHere: 'Open Folder Here',
  renameTitle: 'Rename',
  revealExplorer: 'Reveal in File Explorer',
  revealFileManager: 'Open Containing Folder',
  revealFinder: 'Reveal in Finder',
  revealInSidebar: 'Reveal in filetree',
  saveAs: 'Save as…',
  setAsProjectFolder: 'Set as Project Folder'
}

const DOWNLOADS_COPY = { downloadFolder: 'Download folder as zip' }

const TARGET: FileEntryTarget = {
  isDirectory: false,
  name: 'notes.md',
  path: '/repo/docs/notes.md',
  relativeTo: '/repo'
}

const FOLDER: FileEntryTarget = {
  isDirectory: true,
  name: 'docs',
  path: '/repo/docs',
  relativeTo: '/repo'
}

/**
 * Walk the returned element tree and pull out the rows built with `kit.Item`.
 *
 * The Radix item primitives throw outside a mounted menu ("`MenuItem` must be
 * used within `Menu`"), and opening two real menus would test Radix rather than
 * this builder — so inspect the elements instead of rendering them.
 */
function itemLabels(kit: MenuKit, target: FileEntryTarget = TARGET): string[] {
  const out: string[] = []

  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)

      return
    }

    if (!isValidElement<{ children?: ReactNode }>(node)) {
      return
    }

    if (node.type === kit.Item) {
      out.push(String(node.props.children))

      return
    }

    walk(node.props.children)
  }

  walk(fileEntryMenuItems(target, COPY, DOWNLOADS_COPY)(kit))

  return out
}

beforeEach(() => {
  remote.value = false
  $folderDownloadAvailable.set(null)
})

describe('fileEntryMenuItems', () => {
  it('gives the kebab and the right-click menu the same actions', () => {
    // The point of the shared builder: the touch path and the mouse path cannot
    // drift, because there is only one list feeding both.
    expect(itemLabels(DROPDOWN_KIT)).toEqual(itemLabels(CONTEXT_KIT))
  })

  it('offers reveal, copy, rename and delete on a local filesystem', () => {
    // The reveal row's LABEL is platform-picked (Finder / Explorer / generic)
    // and jsdom does not give it a stable answer: `navigator.platform` is '',
    // so the picker falls through to the user agent — which on a macOS host is
    // "Mozilla/5.0 (darwin) …", and `/win/i` matches the "win" in "darwin".
    // The same test on Linux CI sees "(linux)" and gets the generic label. What
    // this test is actually about is WHICH ACTIONS the builder offers and in
    // what order, so pin that and accept any of the three reveal wordings.
    const [reveal, ...rest] = itemLabels(CONTEXT_KIT)

    expect([COPY.revealFinder, COPY.revealExplorer, COPY.revealFileManager]).toContain(reveal)
    expect(rest).toEqual([COPY.copyPath, COPY.copyRelativePath, COPY.download, COPY.saveAs, COPY.rename, COPY.delete])
  })

  it('drops the filesystem actions on a remote backend, keeping copy', () => {
    remote.value = true

    // Download survives, and that is the point of it: in Universal
    // `isDesktopFsRemoteMode()` is unconditionally true, so a Download hidden
    // behind that guard would never render at all — while the file being on the
    // gateway is exactly what makes downloading it worth offering.
    expect(itemLabels(CONTEXT_KIT)).toEqual([COPY.copyPath, COPY.copyRelativePath, COPY.download, COPY.saveAs])
  })

  it('hides copy-relative-path when there is no base directory', () => {
    expect(itemLabels(CONTEXT_KIT, { ...TARGET, relativeTo: null })).not.toContain(COPY.copyRelativePath)
  })

  it('stays in step across both kits on a remote backend too', () => {
    remote.value = true

    expect(itemLabels(DROPDOWN_KIT)).toEqual(itemLabels(CONTEXT_KIT))
  })

  it('offers the zip download and the project row on a directory', () => {
    remote.value = true

    expect(itemLabels(CONTEXT_KIT, FOLDER)).toEqual([
      COPY.copyPath,
      COPY.copyRelativePath,
      DOWNLOADS_COPY.downloadFolder,
      COPY.saveAs,
      COPY.openFolderHere,
      COPY.setAsProjectFolder
    ])
  })

  it('drops the folder download when the gateway has no archive route', () => {
    // MJXHRM-511 freezes the backend, so an older gateway 404s the archive
    // route. `store/downloads` flips this atom the first time that happens; the
    // affordance has to go with it, or the row is one that does nothing.
    remote.value = true
    $folderDownloadAvailable.set(false)

    const labels = itemLabels(CONTEXT_KIT, FOLDER)

    expect(labels).not.toContain(DOWNLOADS_COPY.downloadFolder)
    // Save as… is the same transfer with a chosen destination, so it goes with
    // it — a dialog that leads to a route the gateway does not have is worse
    // than no row at all.
    expect(labels).not.toContain(COPY.saveAs)
    // …and the two folder rows are unaffected: they have nothing to do with
    // downloads.
    expect(labels).toContain(COPY.openFolderHere)
    expect(labels).toContain(COPY.setAsProjectFolder)
  })

  it('never offers either folder row for a file', () => {
    // "Open Folder Here" re-roots the tree at a DIRECTORY; on a file it would be
    // an action with no meaning, the way Set as Project Folder already is.
    expect(itemLabels(CONTEXT_KIT)).not.toContain(COPY.openFolderHere)
    expect(itemLabels(CONTEXT_KIT)).not.toContain(COPY.setAsProjectFolder)
  })
})
