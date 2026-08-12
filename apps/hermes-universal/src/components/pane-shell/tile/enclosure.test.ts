/**
 * ENCLOSURE — and specifically WHICH enclosure unmounts (MJXHRM-373).
 *
 * `collapsed` and `minimized` are presentational: the content stays mounted and
 * comes straight back. `narrowCollapsed` is the one that UNMOUNTS, because at
 * that width the edge overlay (NarrowOverlays) owns the single live instance of
 * the pane instead.
 *
 * That makes it the last remaining way for the layout engine to tear a surface
 * down without being asked — the same defect MJXHRM-373 fixed for minimize. A
 * terminal on the local transport dies with its component (`pty_kill` runs in
 * `TerminalView`'s cleanup), so "which container state unmounts" is a
 * process-lifetime decision, and it must never fire for a pane the BREAKPOINT
 * did not take out of the grid.
 */

import { describe, expect, it } from 'vitest'

import { group, split } from '../tree/model'
import type { LayoutNode } from '../tree/model'

import { type EnclosureContext, zoneEnclosure } from './enclosure'
import type { Tile } from './types'

/** `sessions`/`files` are the collapsible chrome panes; `terminal` is a tool
 *  panel that stays in the grid at every width (it declares no `collapsible`). */
const TILES: Record<string, Tile> = {
  files: {
    chrome: { collapsible: true },
    id: 'files',
    kind: 'files',
    placement: 'right',
    render: () => null,
    title: 'files'
  },
  review: {
    chrome: { collapsible: true },
    id: 'review',
    kind: 'review',
    placement: 'right',
    render: () => null,
    title: 'review'
  },
  terminal: {
    chrome: { toolPanel: true },
    id: 'terminal',
    kind: 'terminal',
    placement: 'bottom',
    render: () => null,
    title: 'terminal'
  },
  workspace: { id: 'workspace', kind: 'chat', placement: 'main', render: () => null, title: 'workspace' }
}

function ctx(over: Partial<EnclosureContext> = {}): EnclosureContext {
  const hidden = over.hidden ?? new Set<string>()
  const narrow = over.narrow ?? false
  const editMode = over.editMode ?? false
  const tileFor = (id: string) => TILES[id]

  return {
    collapsedSides: new Set(),
    editMode,
    hidden,
    narrow,
    overrides: {},
    paneFor: tileFor,
    // The production predicate (tile/visibility.ts), inlined the way the split
    // renderer builds it.
    paneGone: id =>
      !tileFor(id) || (narrow && Boolean(tileFor(id)?.chrome?.collapsible)) || (hidden.has(id) && !editMode),
    rootRow: true,
    tileFor,
    ...over
  }
}

/** The default layout's right column: the file rail over the terminal deck. */
const rightColumn = (): LayoutNode =>
  split(
    'column',
    [group(['files'], { id: 'grp-files' }), group(['terminal'], { id: 'grp-terminal' })],
    [1, 1],
    'spl-right'
  )

describe('narrowCollapsed — the only enclosure that unmounts', () => {
  it('fires for a chrome pane the BREAKPOINT took out of the grid', () => {
    // Its live instance moves to the edge overlay, so the docked one must go.
    const enclosure = zoneEnclosure(group(['files'], { id: 'grp-files' }), ctx({ narrow: true }), true)

    expect(enclosure.collapsed).toBe(true)
    expect(enclosure.narrowCollapsed).toBe(true)
  })

  it('does NOT fire for a side a chrome TOGGLE closed, even on a narrow window', () => {
    // ⌘J on a narrow window. `sideGone` collapses the column to `display:none`
    // — that is a hide, and the terminal in it has no edge overlay to move to.
    // Unmounting it here runs TerminalView's cleanup and kills the shell.
    const enclosure = zoneEnclosure(rightColumn(), ctx({ collapsedSides: new Set(['right']), narrow: true }), true)

    expect(enclosure.collapsed).toBe(true)
    expect(enclosure.narrowCollapsed).toBe(false)
  })

  it('does not fire for the same side collapse on a wide window', () => {
    const enclosure = zoneEnclosure(rightColumn(), ctx({ collapsedSides: new Set(['right']) }), true)

    expect(enclosure.collapsed).toBe(true)
    expect(enclosure.narrowCollapsed).toBe(false)
  })

  it('still fires when the toggled-off side holds ONLY collapsible panes', () => {
    // Every pane in it is enclosed anyway, so the overlay owns them all and
    // there is nothing left in the column to keep mounted.
    const column = split('column', [group(['files']), group(['review'])], [1, 1], 'spl-rail')
    const enclosure = zoneEnclosure(column, ctx({ collapsedSides: new Set(['right']), narrow: true }), true)

    expect(enclosure.narrowCollapsed).toBe(true)
  })

  it('does not fire for a zone whose panes a store merely hid', () => {
    // ⌘G-closed review: `hidden` is the reveal axis, and the toggle promises to
    // bring the surface straight back — so the zone collapses but keeps its
    // content. (Unchanged by MJXHRM-373; asserted so it stays that way.)
    const enclosure = zoneEnclosure(group(['review'], { id: 'grp-review' }), ctx({ hidden: new Set(['review']) }), true)

    expect(enclosure.collapsed).toBe(true)
    expect(enclosure.narrowCollapsed).toBe(false)
  })

  it('does not fire for a minimized zone — the case MJXHRM-373 fixed', () => {
    const enclosure = zoneEnclosure(group(['terminal'], { id: 'grp-terminal', minimized: true }), ctx(), false)

    expect(enclosure.minimized).toBe(true)
    expect(enclosure.collapsed).toBe(false)
    expect(enclosure.narrowCollapsed).toBe(false)
  })
})
