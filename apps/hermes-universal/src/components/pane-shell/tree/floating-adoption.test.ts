/**
 * A `placement: 'floating'` tile must never enter the layout tree.
 *
 * Adoption is what turns a registered tile into a track — and therefore into
 * something that steals width from a zone — so these exercise the real
 * `adoptContributedPanes` path via `watchContributedPanes` rather than
 * asserting on the filter in isolation.
 *
 * Ported from desktop `floating-adoption.test.ts`, plus the flat-payload case:
 * universal reads tiles through `toTile`, and a plugin registering the flat
 * shape is the contract that can't be migrated by editing this repo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('floating tiles stay out of the layout tree', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  async function setup() {
    const tree = await import('@/components/pane-shell/tree/store')
    const model = await import('@/components/pane-shell/tree/model')
    const { registerTiles } = await import('@/components/pane-shell/tile/registry')
    const { registry } = await import('@/contrib/registry')

    registerTiles([{ id: 'workspace', kind: 'chat', title: 'chat', render: () => null, placement: 'main' }])

    tree.declareDefaultTree(model.group(['workspace'], { id: 'grp-main' }))

    return { model, registerTiles, registry, tree }
  }

  it('does not adopt a floating tile, while still adopting a docked one', async () => {
    const { model, registerTiles, tree } = await setup()

    registerTiles([
      {
        id: 'hud',
        kind: 'hud',
        title: 'HUD',
        render: () => null,
        placement: 'floating',
        chrome: { anchor: 'top-right' },
        sizing: { width: '240px' }
      },
      { id: 'files', kind: 'files', title: 'Files', render: () => null, placement: 'right' }
    ])

    tree.watchContributedPanes()

    const ids = model.allPaneIds(tree.$layoutTree.get()!)

    expect(ids).not.toContain('hud')
    // Control: a normal placement DOES get adopted through the same pass, so
    // the exclusion is specific to 'floating', not a broken adoption run.
    expect(ids).toContain('files')
  })

  it('keeps the main zone unsplit when only a floating tile registers', async () => {
    const { model, registerTiles, tree } = await setup()

    registerTiles([{ id: 'hud', kind: 'hud', title: 'HUD', render: () => null, placement: 'floating' }])

    tree.watchContributedPanes()

    const root = tree.$layoutTree.get()!

    // Still the single group it was declared as — no track was created.
    expect(root.type).toBe('group')
    expect(model.allPaneIds(root)).toEqual(['workspace'])
  })

  it('survives a registry change without ever adopting the floating tile', async () => {
    const { model, registerTiles, tree } = await setup()

    registerTiles([{ id: 'hud', kind: 'hud', title: 'HUD', render: () => null, placement: 'floating' }])
    tree.watchContributedPanes()

    // A later registration re-runs adoption via the registry subscription.
    registerTiles([{ id: 'terminal', kind: 'terminal', title: 'Terminal', render: () => null, placement: 'bottom' }])

    const ids = model.allPaneIds(tree.$layoutTree.get()!)

    expect(ids).toContain('terminal')
    expect(ids).not.toContain('hud')
  })

  it('honours the FLAT plugin payload — placement and anchor both survive toTile', async () => {
    const { model, registry, tree } = await setup()
    const { findTile } = await import('@/components/pane-shell/tile/registry')

    // The shape the published SDK still accepts: chrome keys, sizing keys and
    // placement side by side in one blob.
    registry.register({
      id: 'hud',
      area: 'panes',
      title: 'HUD',
      data: { placement: 'floating', anchor: 'bottom-left', width: '216px' },
      render: () => null
    })

    tree.watchContributedPanes()

    expect(model.allPaneIds(tree.$layoutTree.get()!)).not.toContain('hud')

    const tile = findTile('hud')

    expect(tile?.placement).toBe('floating')
    // Without 'anchor' in CHROME_KEYS this is silently dropped and the card
    // spawns in the wrong corner — a failure nothing else would catch.
    expect(tile?.chrome?.anchor).toBe('bottom-left')
    expect(tile?.sizing?.width).toBe('216px')
  })
})
