/**
 * PREVIEW TILES in the layout tree.
 *
 * The point of the migration this file guards is that a preview tab is a ZONE
 * tab — so the second file you open has to land in the FIRST one's strip, not
 * in a column of its own. Exercised through the real `adoptContributedPanes`
 * pass (via `watchContributedPanes`) rather than by asserting on the dock hint,
 * because the hint is only half the answer: adoption resolves the anchor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TileChrome } from '@/components/pane-shell/tile/types'
import type * as TreeModel from '@/components/pane-shell/tree/model'

describe('preview tiles', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  async function setup() {
    const model = await import('@/components/pane-shell/tree/model')
    const tree = await import('@/components/pane-shell/tree/store')
    const { registerTiles } = await import('@/components/pane-shell/tile/registry')
    const preview = await import('@/store/preview')
    const { watchPreviewTiles } = await import('./preview-tile')

    registerTiles([
      {
        id: 'workspace',
        kind: 'chat',
        title: 'chat',
        render: () => null,
        placement: 'main',
        chrome: { uncloseable: true }
      }
    ])

    tree.declareDefaultTree(model.group(['workspace'], { id: 'grp-main' }))
    tree.watchContributedPanes()
    watchPreviewTiles()

    return { model, preview, tree }
  }

  /** The group holding `paneId`, by id. */
  const groupOf = (model: typeof TreeModel, node: TreeModel.LayoutNode, paneId: string) =>
    model.findGroupOfPane(node, paneId)?.id

  it('stacks a second preview into the first preview zone instead of a new column', async () => {
    const { model, preview, tree } = await setup()

    preview.setPreviewTarget('/a.ts')
    preview.setPreviewTarget('/b.ts')

    const node = tree.$layoutTree.get()!
    const a = groupOf(model, node, 'preview-tile:/a.ts')
    const b = groupOf(model, node, 'preview-tile:/b.ts')

    expect(a).toBeDefined()
    // Both previews share ONE zone...
    expect(b).toBe(a)
    // ...and it is not the workspace's.
    expect(a).not.toBe(groupOf(model, node, 'workspace'))
  })

  it('leaves the workspace beside the preview zone, not inside it', async () => {
    const { model, preview, tree } = await setup()

    preview.setPreviewTarget('/a.ts')

    const node = tree.$layoutTree.get()!

    expect(model.allPaneIds(node)).toEqual(expect.arrayContaining(['workspace', 'preview-tile:/a.ts']))
    expect(groupOf(model, node, 'preview-tile:/a.ts')).not.toBe(groupOf(model, node, 'workspace'))
  })

  it('drops the pane again when the tab closes', async () => {
    const { model, preview, tree } = await setup()

    preview.setPreviewTarget('/a.ts')
    preview.closePreviewTab('/a.ts')

    expect(model.allPaneIds(tree.$layoutTree.get()!)).not.toContain('preview-tile:/a.ts')
  })

  // The source / rendered / diff switch is a FILE question. An artifact reads
  // from the registry and carries its own controls, so handing it the file
  // glyphs put two permanently disabled buttons and a live `diff` that wrote a
  // mode nothing reads onto its strip.
  it('contributes the view-mode glyphs to a file tab and none to an artifact tab', async () => {
    const { preview } = await setup()
    const { registry } = await import('@/contrib/registry')

    preview.setPreviewTarget('/a.ts')
    preview.openArtifactPreviewTab('art-1', 'Dashboard')

    const chromeOf = (paneId: string) =>
      (registry.getArea('panes').find(c => c.id === paneId)?.data as { chrome?: TileChrome })?.chrome

    expect(
      chromeOf('preview-tile:/a.ts')
        ?.stripTools?.()
        .map(tool => tool.id)
    ).toEqual(['preview-source', 'preview-rendered', 'preview-diff'])
    expect(chromeOf('preview-tile:artifact:art-1')?.stripTools?.()).toEqual([])
  })

  it('leads a file tab with its file-type icon and a dirty one with the modified dot', async () => {
    const { preview } = await setup()
    const { render } = await import('@testing-library/react')
    const { registry } = await import('@/contrib/registry')
    const { setPreviewDirty } = await import('@/store/preview-edit')

    preview.setPreviewTarget('/a.ts')

    const chrome = (registry.getArea('panes').find(c => c.id === 'preview-tile:/a.ts')?.data as { chrome?: TileChrome })
      ?.chrome

    const clean = render(<>{chrome?.tabLead?.()}</>)

    expect(clean.container.querySelector('.bg-amber-500')).toBeNull()
    expect(clean.container.firstElementChild).not.toBeNull()

    setPreviewDirty('/a.ts', true)

    // The lead re-reads the store on its own — the tile is not re-registered.
    const dirty = render(<>{chrome?.tabLead?.()}</>)

    expect(dirty.container.querySelector('.bg-amber-500')).not.toBeNull()
  })
})
