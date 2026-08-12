/**
 * A COLLAPSED ZONE'S RAIL IS STILL A TAB STRIP (MJXHRM-409).
 *
 * A zone folded inside a ROW collapses to a narrow VERTICAL rail rather than a
 * horizontal header — same `PaneTab` shells, same `data-tree-tab` markers, same
 * zone menu behind them. Two things the header strip does for that menu were
 * never done for the rail:
 *
 *  - the header resolves `menuPane` from the pressed element on `contextmenu`,
 *    so every verb in the menu (Close / others / to the right / all, plus
 *    Reload, Split, Detach) names the tab the user actually right-clicked. The
 *    rail set nothing — and `menuPane` is STICKY, nothing clears it — so the
 *    rail's menu acted on the active pane, or on whatever tab happened to be
 *    right-clicked in the header before the zone folded;
 *  - the header applies `chrome.tabWrap`, which is how a session tab carries
 *    its own menu (pin/rename/branch/archive/delete + Reload + the shared close
 *    group). The rail rendered the bare tab, so folding a chat zone silently
 *    swapped a session tab's menu for the zone's.
 *
 * Both are the same class of defect the ticket names: a tab surface that never
 * got wired to what every other tab surface has.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { group } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'

import { $layoutEditMode } from '../../edit-mode'
import { registerTiles } from '../../tile/registry'

import { TreeGroup } from './tree-group'

const ZONE = 'stack'

let disposeTiles: (() => void) | null = null

const zone = (minimized?: boolean) => group(['alpha', 'beta', 'gamma'], { active: 'alpha', id: ZONE, minimized })

/** Pane ids still in the tree, in strip order. */
const panes = () => {
  const tree = $layoutTree.get()

  return tree?.type === 'group' ? tree.panes : []
}

const tab = (paneId: string) => document.querySelector<HTMLElement>(`[data-tree-tab="${paneId}"]`)!

/** The edit-mode veil — the zone menu's third mount point. */
const veil = () => document.querySelector<HTMLElement>('[class*="cursor-grab"][class*="backdrop-blur"]')!

// Radix needs both to open a context menu in jsdom.
const openMenuOn = (target: HTMLElement) => {
  fireEvent.pointerDown(target, { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(target, { button: 2 })
}

const clickItem = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }))

beforeEach(() => {
  $layoutTree.set(zone())

  disposeTiles = registerTiles(
    ['alpha', 'beta', 'gamma'].map(id => ({
      id,
      kind: id,
      title: id.toUpperCase(),
      placement: 'main' as const,
      render: () => <p>{id}</p>
    }))
  )
})

afterEach(() => {
  cleanup()
  disposeTiles?.()
  disposeTiles = null
  $layoutTree.set(null)
  $layoutEditMode.set(false)
})

describe('the zone menu names the tab that was right-clicked', () => {
  it('closes the rail tab under the pointer, not the zone-active one', () => {
    render(<TreeGroup node={zone(true)} parentAxis="row" />)

    // The collapsed-in-a-row form: a vertical rail, one tab per pane.
    expect(tab('beta')).toBeTruthy()

    openMenuOn(tab('beta'))
    clickItem('Close')

    expect(panes()).toEqual(['alpha', 'gamma'])
  })

  it('scopes Close others and Close to the right to that same tab', () => {
    render(<TreeGroup node={zone(true)} parentAxis="row" />)

    openMenuOn(tab('beta'))
    clickItem('Close to the right')

    // `gamma` sits right of `beta`; `alpha` sits left of it and survives. Aimed
    // at the active pane instead, this would have closed BOTH siblings.
    expect(panes()).toEqual(['alpha', 'beta'])
  })

  it('does not inherit the header strip’s last target after the zone folds', () => {
    // `menuPane` survives the menu that set it, so the rail has to overwrite it
    // rather than rely on it being empty.
    const view = render(<TreeGroup node={zone()} parentAxis="row" />)

    openMenuOn(tab('gamma'))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    view.rerender(<TreeGroup node={zone(true)} parentAxis="row" />)

    openMenuOn(tab('beta'))
    clickItem('Close')

    expect(panes()).toEqual(['alpha', 'gamma'])
  })

  it('falls back to the active pane on the edit veil, which covers no tabs', () => {
    // The veil is the third mount point of the same menu, and it is the reason
    // "clear it" matters as much as "set it": right-clicking CONTENT names no
    // tab, so the menu must mean the active pane — but the previous target
    // outlives the menu that set it, so the veil has to overwrite it too.
    render(<TreeGroup node={zone()} />)

    openMenuOn(tab('gamma'))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    act(() => $layoutEditMode.set(true))
    openMenuOn(veil())
    clickItem('Close')

    expect(panes()).toEqual(['beta', 'gamma'])
  })

  it('still names the pressed tab in the horizontal header strip', () => {
    // The header path shares one handler with the rail now — this is the case
    // that already worked, held in place across that refactor.
    render(<TreeGroup node={zone()} />)

    openMenuOn(tab('gamma'))
    clickItem('Close')

    expect(panes()).toEqual(['alpha', 'beta'])
  })
})

describe("a folded zone keeps a tile's own tab menu", () => {
  it('applies chrome.tabWrap in the vertical rail, as the header strip does', () => {
    disposeTiles?.()
    disposeTiles = registerTiles([
      {
        id: 'alpha',
        kind: 'alpha',
        title: 'ALPHA',
        placement: 'main',
        chrome: { tabWrap: (el: ReactElement) => <div data-testid="wrapped-alpha">{el}</div> },
        render: () => <p>alpha</p>
      },
      { id: 'beta', kind: 'beta', title: 'BETA', placement: 'main', render: () => <p>beta</p> },
      { id: 'gamma', kind: 'gamma', title: 'GAMMA', placement: 'main', render: () => <p>gamma</p> }
    ])

    render(<TreeGroup node={zone(true)} parentAxis="row" />)

    expect(screen.getByTestId('wrapped-alpha').querySelector('[data-tree-tab="alpha"]')).toBeTruthy()
  })
})
