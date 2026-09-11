import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { IS_MOBILE } from '@/lib/platform'

import { ProjectTree } from './tree'
import type { TreeNode } from './use-project-tree'

const CWD = '/repo'

const NODES: TreeNode[] = [
  { id: '/repo/docs', isDirectory: true, name: 'docs' },
  { id: '/repo/notes.md', isDirectory: false, name: 'notes.md' }
] as TreeNode[]

const COPY_PATH = 'Copy Path'
const FILE_ACTIONS = 'File actions'

function Harness({ nonce }: { nonce: number }) {
  return (
    <ProjectTree
      collapseNonce={0}
      cwd={CWD}
      data={NODES}
      key="tree"
      onActivateFile={() => {}}
      onActivateFolder={() => {}}
      onLoadChildren={() => {}}
      onNodeOpenChange={() => {}}
      // A fresh object every render, exactly as the pane hands one down.
      openState={{ ...{}, [`nonce-${nonce}`]: false }}
    />
  )
}

/** The pane above the tree, with a button that re-renders it — the shape of
 *  every real update (a git-status tick, an agent edit revalidating the tree,
 *  the sidebar resizing). */
function renderPane() {
  function Pane() {
    const [nonce, setNonce] = useState(0)

    return (
      <I18nProvider>
        <button data-testid="repaint" onClick={() => setNonce(n => n + 1)} type="button">
          repaint
        </button>
        <Harness nonce={nonce} />
      </I18nProvider>
    )
  }

  return render(<Pane />)
}

/** What a user's pointer is actually over when they right-click a row: the
 *  name itself, which bubbles up to the trigger. */
function labelFor(name: string): HTMLElement {
  return screen.getByText(name)
}

/** The presentational row (the `group/row` div), not arborist's container. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.group\\/row')

  if (!(row instanceof HTMLElement)) {
    throw new Error(`no row for ${name}`)
  }

  return row
}

function menuItem(name: string): HTMLElement | null {
  return screen.queryByRole('menuitem', { name })
}

function openKebab(row: HTMLElement): HTMLElement {
  const kebab = row.querySelector<HTMLButtonElement>(`button[aria-label="${FILE_ACTIONS}"]`)

  if (!kebab) {
    throw new Error('no kebab on this row')
  }

  fireEvent.pointerDown(kebab, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(kebab)

  return kebab
}

beforeEach(() => {
  // jsdom lays nothing out, and the tree renders a skeleton until it has a
  // measured height — so hand it one.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 600,
    height: 600,
    left: 0,
    right: 300,
    toJSON: () => ({}),
    top: 0,
    width: 300,
    x: 0,
    y: 0
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      disconnect() {}
      observe(target: Element) {
        this.callback([{ contentRect: { height: 600 }, target } as unknown as ResizeObserverEntry], this as never)
      }
      unobserve() {}
    } as unknown as typeof ResizeObserver
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProjectTree row menus', () => {
  // `tree.tsx` renders no context-menu trigger at all when this is true, so
  // every right-click assertion below would pass vacuously on a mis-sniffed
  // desktop. Pin the branch these tests are actually about.
  it('runs on the desktop branch', () => {
    expect(IS_MOBILE).toBe(false)
  })

  it('opens the context menu on a right-click on a file row', () => {
    renderPane()

    fireEvent.contextMenu(labelFor('notes.md'))

    expect(menuItem(COPY_PATH)).toBeTruthy()
    expect(menuItem('Copy Relative Path')).toBeTruthy()
    // File, so no folder-only rows.
    expect(menuItem('Set as Project Folder')).toBeNull()
  })

  it('opens the context menu on a right-click on a folder row', () => {
    renderPane()

    fireEvent.contextMenu(labelFor('docs'))

    expect(menuItem(COPY_PATH)).toBeTruthy()
    expect(menuItem('Set as Project Folder')).toBeTruthy()
  })

  it('opens the kebab menu', () => {
    renderPane()

    openKebab(rowFor('notes.md'))

    expect(menuItem(COPY_PATH)).toBeTruthy()
  })

  // THE regression. `props.children` is react-arborist's node-renderer ELEMENT
  // TYPE; an inline arrow made every re-render a new type, so React unmounted
  // and rebuilt every visible row — taking the open menu's own trigger with it,
  // which is "everything disappears when I pick an option".
  it('keeps an open context menu alive across a pane re-render', () => {
    renderPane()

    fireEvent.contextMenu(labelFor('notes.md'))
    expect(menuItem(COPY_PATH)).toBeTruthy()

    fireEvent.click(screen.getByTestId('repaint'))

    expect(menuItem(COPY_PATH)).toBeTruthy()
  })

  it('keeps an open kebab menu alive across a pane re-render, and still runs its action', () => {
    renderPane()

    openKebab(rowFor('notes.md'))
    expect(menuItem(COPY_PATH)).toBeTruthy()

    fireEvent.click(screen.getByTestId('repaint'))

    const item = menuItem(COPY_PATH)
    expect(item).toBeTruthy()

    // And the row that owns it is still the same DOM node — a rebuilt row would
    // have orphaned the portal before `onSelect` could resolve.
    fireEvent.click(item as HTMLElement)
    expect(menuItem(COPY_PATH)).toBeNull()
  })

  // The kebab and the right-click trigger are SIBLINGS, not one inside the
  // other: two Radix roots on one element share a pointer stream, and the
  // context trigger's own pointerdown/move/up (its touch long-press) would keep
  // seeing a gesture the kebab only stopped at `pointerdown`.
  it('renders the kebab outside the context-menu trigger', () => {
    renderPane()

    const row = rowFor('notes.md')
    const trigger = row.querySelector('[data-slot="context-menu-trigger"]')
    const kebab = row.querySelector(`button[aria-label="${FILE_ACTIONS}"]`)

    expect(trigger).toBeTruthy()
    expect(kebab).toBeTruthy()
    expect(trigger?.contains(kebab as Node)).toBe(false)
    // Siblings under the row, not one inside the other.
    expect(trigger?.parentElement).toBe(row)
    expect(kebab?.parentElement).toBe(row)
  })

  // jsdom does no hit-testing, so the hit AREA can only be asserted as the
  // layout contract that produces it: the trigger fills the row rather than
  // stopping where the kebab starts, which is what keeps the row's right-hand
  // slack right-clickable now that the kebab is a sibling rather than a child.
  it('lets the trigger span the whole row', () => {
    renderPane()

    const trigger = rowFor('notes.md').querySelector('[data-slot="context-menu-trigger"]')

    expect(trigger?.className).toContain('absolute')
    expect(trigger?.className).toContain('inset-0')
  })

  // The kebab is opacity-0 until the row is hovered; once its menu is open it
  // must stay painted even though the pointer has left `group/row` for a menu
  // portalled to <body>. That is driven by the component's own open state, not
  // by a selector that has to survive the row being re-rendered.
  it('paints the kebab from its own open state', () => {
    renderPane()

    const row = rowFor('notes.md')
    const kebab = row.querySelector<HTMLButtonElement>(`button[aria-label="${FILE_ACTIONS}"]`)

    expect(kebab?.className).toContain('fine:opacity-0')

    openKebab(row)

    const open = rowFor('notes.md').querySelector<HTMLButtonElement>(`button[aria-label="${FILE_ACTIONS}"]`)
    expect(open?.className).toContain('fine:opacity-100')
    expect(open?.className).not.toContain('fine:opacity-0')
  })
})
