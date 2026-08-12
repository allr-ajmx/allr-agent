/**
 * MINIMIZING A ZONE MUST NOT UNMOUNT WHAT IS IN IT (MJXHRM-373).
 *
 * This is a live-DOM test rather than a store test because the bug was neither
 * in the store nor in the terminal: the zone renderer gated its whole body on
 * `{!node.minimized && …}`, so folding a zone tore down every tile inside it.
 * For a terminal on the local transport that ran `TerminalView`'s cleanup, which
 * invokes `pty_kill` — the layout engine ending a shell process. Nothing below
 * the renderer could have defended against it, and nothing below it can pin the
 * fix either.
 *
 * jsdom lays nothing out, so `getBoundingClientRect` is stubbed: the frozen size
 * the body keeps while folded is measured from it, and a zero measurement is
 * (correctly) treated as "never been open" by the component.
 */

import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PANE_HIDDEN_ATTR } from '@/components/pane-shell/pane-visibility'
import { group } from '@/components/pane-shell/tree/model'
import { $hiddenTreePanes, $layoutTree } from '@/components/pane-shell/tree/store'

import { registerTiles } from '../../tile/registry'

import { TreeGroup } from './tree-group'

const ZONE = 'tool-zone'

const mounted = vi.fn()
const unmounted = vi.fn()

/** Stands in for a terminal: its unmount is the thing that used to kill a PTY. */
function LiveSurface() {
  useEffect(() => {
    mounted()

    return () => unmounted()
  }, [])

  return <p data-testid="live">shell</p>
}

let disposeTiles: (() => void) | null = null
let rect: () => DOMRect

const zone = (minimized?: boolean) => group(['terminal'], { active: 'terminal', id: ZONE, minimized })

const body = () => document.querySelector<HTMLElement>('[data-tree-body]')

beforeEach(() => {
  mounted.mockClear()
  unmounted.mockClear()
  $layoutTree.set(zone())

  disposeTiles = registerTiles([
    {
      id: 'terminal',
      kind: 'terminal',
      title: 'Terminal',
      placement: 'bottom',
      chrome: { toolPanel: true },
      render: () => <LiveSurface />
    }
  ])

  // A real, non-zero layout. Without it the component cannot tell an open zone
  // from one that has never been opened.
  rect = () => ({ bottom: 300, height: 300, left: 0, right: 400, toJSON: () => ({}), top: 0, width: 400, x: 0, y: 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect())
})

afterEach(() => {
  cleanup()
  disposeTiles?.()
  disposeTiles = null
  $layoutTree.set(null)
  $hiddenTreePanes.set(new Set())
  vi.restoreAllMocks()
})

/** The tile in `[data-tree-tab]` position — a hidden pane keeps no tab. */
const tabs = () => [...document.querySelectorAll('[data-tree-tab]')].map(el => el.getAttribute('data-tree-tab'))

describe('collapsing a zone', () => {
  it('hides the body instead of unmounting it, so a live PTY survives', () => {
    const view = render(<TreeGroup node={zone()} />)

    expect(mounted).toHaveBeenCalledTimes(1)
    expect(view.getByTestId('live')).toBeTruthy()

    view.rerender(<TreeGroup node={zone(true)} />)

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(unmounted).not.toHaveBeenCalled()
    expect(view.queryByTestId('live')).toBeTruthy()

    // ...and it is genuinely hidden, not merely still on screen.
    expect(body()?.className).toContain('invisible')
    expect(body()?.hasAttribute(PANE_HIDDEN_ATTR)).toBe(true)

    // Frozen at the size it was laid out at, so nothing inside re-measures —
    // a terminal squeezed to zero would refit to one row and reflow its
    // scrollback, which is the state this is protecting.
    expect(body()?.style.height).toBe('300px')
    expect(body()?.style.width).toBe('400px')
  })

  it('restores the body to the flow without remounting it', () => {
    const view = render(<TreeGroup node={zone()} />)

    view.rerender(<TreeGroup node={zone(true)} />)
    view.rerender(<TreeGroup node={zone()} />)

    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    expect(body()?.className).not.toContain('invisible')
    expect(body()?.hasAttribute(PANE_HIDDEN_ATTR)).toBe(false)
    expect(body()?.style.height).toBe('')
  })

  it('stays LAZY for a zone restored from a persisted layout already folded', () => {
    // Nothing has ever mounted in it, so there is nothing to preserve — and
    // eagerly mounting would spawn the shell (or resume the chat) that the
    // zone's whole point is to have deferred.
    render(<TreeGroup node={zone(true)} />)

    expect(mounted).not.toHaveBeenCalled()
    expect(body()).toBeNull()
  })
})

/**
 * THE OTHER HIDE (MJXHRM-373 follow-on).
 *
 * Minimize is one of two ways a zone stops showing a pane without anyone asking
 * for it to be destroyed. The other is the REVEAL axis: `$hiddenTreePanes`, what
 * ⌘G / the titlebar toggles / `bindPaneVisibility` write. Three separate places
 * document that axis as "the zone collapses but the content stays MOUNTED, so
 * toggling back is instant" — `tree/store.ts`'s REVEAL note, `tile/visibility.ts`
 * on the `hidden` outcome, and the `idle()` wrapper in `app/contrib/controller`.
 * The renderer did not do it: `keptPanes` filters `shown`, and a hidden pane is
 * not shown, so hiding tore the surface down exactly like minimize used to.
 */
describe('a pane its owning store hid', () => {
  it('keeps its body mounted, so a live surface survives the toggle', () => {
    const view = render(<TreeGroup node={zone()} />)

    expect(mounted).toHaveBeenCalledTimes(1)

    act(() => $hiddenTreePanes.set(new Set(['terminal'])))

    expect(unmounted).not.toHaveBeenCalled()
    expect(view.queryByTestId('live')).toBeTruthy()

    // Hidden the way an inactive tab is: no tab in the strip, and the content
    // declares itself hidden so document-wide lookups skip it.
    expect(tabs()).toEqual([])
    expect(view.queryByTestId('live')?.closest(`[${PANE_HIDDEN_ATTR}]`)).toBeTruthy()
  })

  it('comes back without remounting when the toggle reopens it', () => {
    const view = render(<TreeGroup node={zone()} />)

    act(() => $hiddenTreePanes.set(new Set(['terminal'])))
    act(() => $hiddenTreePanes.set(new Set()))

    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
    expect(tabs()).toEqual(['terminal'])
    expect(view.queryByTestId('live')?.closest(`[${PANE_HIDDEN_ATTR}]`)).toBeNull()
  })

  it('stays LAZY for a pane hidden before it was ever shown', () => {
    // Boot with the pane toggled off: there is no state to preserve yet, and
    // mounting it would spawn the shell / fetch the tree nobody has asked for.
    $hiddenTreePanes.set(new Set(['terminal']))

    render(<TreeGroup node={zone()} />)

    expect(mounted).not.toHaveBeenCalled()
  })
})
