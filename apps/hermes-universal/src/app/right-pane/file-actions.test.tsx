import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTEXT_KIT, DROPDOWN_KIT, type MenuKit } from '@/components/ui/actions-menu'

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
  pathCopied: 'Path copied',
  rename: 'Rename…',
  renameLabel: 'New name',
  renameTitle: 'Rename',
  revealExplorer: 'Reveal in File Explorer',
  revealFileManager: 'Open Containing Folder',
  revealFinder: 'Reveal in Finder',
  revealInSidebar: 'Reveal in filetree'
}

const TARGET: FileEntryTarget = {
  isDirectory: false,
  name: 'notes.md',
  path: '/repo/docs/notes.md',
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

  walk(fileEntryMenuItems(target, COPY)(kit))

  return out
}

beforeEach(() => {
  remote.value = false
})

describe('fileEntryMenuItems', () => {
  it('gives the kebab and the right-click menu the same actions', () => {
    // The point of the shared builder: the touch path and the mouse path cannot
    // drift, because there is only one list feeding both.
    expect(itemLabels(DROPDOWN_KIT)).toEqual(itemLabels(CONTEXT_KIT))
  })

  it('offers reveal, copy, rename and delete on a local filesystem', () => {
    expect(itemLabels(CONTEXT_KIT)).toEqual([
      COPY.revealFileManager,
      COPY.copyPath,
      COPY.copyRelativePath,
      COPY.rename,
      COPY.delete
    ])
  })

  it('drops the filesystem actions on a remote backend, keeping copy', () => {
    remote.value = true

    expect(itemLabels(CONTEXT_KIT)).toEqual([COPY.copyPath, COPY.copyRelativePath])
  })

  it('hides copy-relative-path when there is no base directory', () => {
    expect(itemLabels(CONTEXT_KIT, { ...TARGET, relativeTo: null })).not.toContain(COPY.copyRelativePath)
  })

  it('stays in step across both kits on a remote backend too', () => {
    remote.value = true

    expect(itemLabels(DROPDOWN_KIT)).toEqual(itemLabels(CONTEXT_KIT))
  })
})
