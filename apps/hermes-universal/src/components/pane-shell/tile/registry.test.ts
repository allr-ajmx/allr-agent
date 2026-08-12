/**
 * The tile registry facade (MJXHRM-165).
 *
 * What these pin is the ONE thing the facade exists to guarantee: the
 * `data: unknown` payload is written and read in a single place, so a caller
 * can never see a half-typed tile. Before this module, chrome and sizing were
 * two independent blind casts of the same blob and a registration site could
 * invent a key (`dock`, `revealOnPreset`) that nothing declared.
 */

import { describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { findTile, getTiles, PANES_AREA, registerTile, registerTiles, toTile } from './registry'
import type { Tile } from './types'
import { tileChrome, tileSizing } from './types'

const base = (id: string, over: Partial<Tile> = {}): Tile => ({
  id,
  kind: 'test',
  title: id,
  render: () => null,
  ...over
})

describe('registerTile / findTile', () => {
  it('round-trips every declared field through the contribution transport', () => {
    const dispose = registerTile(
      base('files', {
        placement: 'right',
        chrome: { collapsible: true, dock: { pane: 'workspace', pos: 'right' }, revealAliases: ['file-tree'] },
        sizing: { width: '237px', minWidth: '180px' },
        lifecycle: 'keep-alive'
      })
    )

    const tile = findTile('files')

    expect(tile?.kind).toBe('test')
    expect(tile?.placement).toBe('right')
    expect(tile?.lifecycle).toBe('keep-alive')
    expect(tileChrome(tile).collapsible).toBe(true)
    expect(tileChrome(tile).dock).toEqual({ pane: 'workspace', pos: 'right' })
    expect(tileChrome(tile).revealAliases).toEqual(['file-tree'])
    expect(tileSizing(tile).width).toBe('237px')

    dispose()
    expect(findTile('files')).toBeUndefined()
  })

  // MJXHRM-385. `tabLead` is a FUNCTION on the payload, and a session tab losing
  // it means losing its status dot while every other field survives.
  it('round-trips the tabLead slot — a node, not a colour string', () => {
    const lead = () => null
    const dispose = registerTile(base('session-tile:abc', { chrome: { accent: '#f00', tabLead: lead } }))

    expect(tileChrome(findTile('session-tile:abc')).tabLead).toBe(lead)
    // `accent` still round-trips beside it: the two are a slot and its
    // string-only fallback, not alternatives the registry has to choose between.
    expect(tileChrome(findTile('session-tile:abc')).accent).toBe('#f00')

    dispose()
  })

  // The test above goes through `registerTile`, which writes the STRUCTURED
  // payload — and `readPayload` returns that verbatim, never consulting the key
  // list at all. So it passed with `tabLead` deleted from `CHROME_KEYS`, which
  // is the one thing its comment claimed to guard. The list only governs the
  // FLAT (plugin SDK) shape, so that is what has to be registered to test it.
  it('copies every chrome key off a FLAT plugin payload, tabLead included', () => {
    const lead = () => null
    const wrap = (tab: never) => tab

    const flat = {
      accent: '#f00',
      // The three keys that WERE being dropped: added to `TileChrome` long after
      // the key list was written, and never listed in it.
      linkTarget: true,
      tabLead: lead,
      tabWrap: wrap,
      toolPanel: true,
      width: '200px'
    }

    const tile = toTile({ area: PANES_AREA, data: flat, id: 'plugin-pane', render: () => null, source: 'plugin' })

    expect(tileChrome(tile).tabLead).toBe(lead)
    expect(tileChrome(tile).tabWrap).toBe(wrap)
    expect(tileChrome(tile).accent).toBe('#f00')
    expect(tileChrome(tile).linkTarget).toBe(true)
    expect(tileChrome(tile).toolPanel).toBe(true)
    expect(tileSizing(tile).width).toBe('200px')
  })

  it('titles default to the id, so a tab is never blank', () => {
    const dispose = registerTile({ id: 'terminal', kind: 'terminal', title: '', render: () => null })

    expect(findTile('terminal')?.title).toBe('terminal')
    dispose()
  })

  it('re-registering an id replaces it in place — this is how live retitling works', () => {
    const first = registerTile(base('workspace', { title: 'New session' }))
    registerTile(base('workspace', { title: 'Fix the bundle' }))

    expect(getTiles().filter(t => t.id === 'workspace')).toHaveLength(1)
    expect(findTile('workspace')?.title).toBe('Fix the bundle')

    first()
    expect(findTile('workspace')).toBeUndefined()
  })

  it('registerTiles disposes the whole batch', () => {
    const dispose = registerTiles([base('a'), base('b'), base('c')])

    expect(getTiles().map(t => t.id)).toEqual(expect.arrayContaining(['a', 'b', 'c']))

    dispose()
    expect(findTile('a')).toBeUndefined()
    expect(findTile('c')).toBeUndefined()
  })
})

describe('toTile — the flat (plugin) payload', () => {
  // THE REGRESSION GUARD FOR THE PLUGIN CONTRACT. A third-party plugin compiled
  // against the shipped SDK writes chrome and sizing keys side by side in one
  // flat `data` blob; it cannot be migrated by editing this repo. If `toTile`
  // ever goes back to rejecting what it doesn't recognise, every plugin pane
  // silently vanishes from the tree — and no in-tree test would notice, because
  // no bundled plugin registers a pane.
  it('normalizes a flat blob into structured chrome + sizing', () => {
    const dispose = registry.register({
      id: 'board',
      area: PANES_AREA,
      title: 'Kanban',
      source: 'plugin:kanban',
      data: { placement: 'right', collapsible: true, width: '20rem', minWidth: '12rem' },
      render: () => null
    })

    const tile = findTile('board')

    expect(tile).toBeDefined()
    expect(tile?.placement).toBe('right')
    expect(tileChrome(tile).collapsible).toBe(true)
    expect(tileSizing(tile).width).toBe('20rem')
    expect(tileSizing(tile).minWidth).toBe('12rem')
    // Derived from provenance, never invented — and never branched on.
    expect(tile?.kind).toBe('plugin:kanban')
    expect(getTiles().some(t => t.id === 'board')).toBe(true)

    dispose()
  })

  it('gives a bare pane contribution a usable tile rather than dropping it', () => {
    const dispose = registry.register({ id: 'bare', area: PANES_AREA, render: () => null })

    expect(findTile('bare')?.kind).toBe('pane')
    expect(findTile('bare')?.title).toBe('bare')

    dispose()
  })
})

describe('toTile', () => {
  it('rejects a contribution with no render — a leaf that renders nothing is a hole, not a tile', () => {
    const dispose = registry.register({ id: 'dataOnly', area: PANES_AREA, data: { kind: 'test' } })

    expect(findTile('dataOnly')).toBeUndefined()

    dispose()
  })

  it('is undefined for an unregistered id (a plugin that has not loaded)', () => {
    expect(toTile(undefined)).toBeUndefined()
    expect(findTile('nothing-here')).toBeUndefined()
  })
})

describe('getTiles', () => {
  it('is referentially stable until the area mutates — it is used as a memo dep', () => {
    const dispose = registerTile(base('stable'))

    const first = getTiles()
    expect(getTiles()).toBe(first)

    const second = registerTile(base('other'))
    expect(getTiles()).not.toBe(first)

    dispose()
    second()
  })
})
