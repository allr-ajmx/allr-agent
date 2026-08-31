/**
 * MJXHRM-381 — RENDER-COUNT PROOF for the zone's narrowed subscriptions.
 *
 * `TreeGroup` reads four global atoms — `$detachedTiles`, `$panesWithCloser`,
 * `$treePaneEpochs`, `$tabSelection` — that are ABOUT one zone but stored for
 * the whole tree. PR #136 replaced the whole-value `useStore` reads with
 * `useStoreSelector` calls that collapse to a scalar, so a write concerning zone
 * A stops re-rendering zone B (its header, its tab strip, and the
 * `menuDirections` walk with them). Nothing pinned that, and a narrowing is
 * exactly the kind of change that can be reverted, or defeated one layer out,
 * without any test noticing.
 *
 * HOW THIS MEASURES: `Profiler.onRender` fires once per COMMIT of the profiled
 * subtree. A selector that bails on `Object.is` produces no re-render and so no
 * call; a whole-atom read re-renders (and commits) even when the output is
 * identical. Two zones are mounted and the OTHER one is written to.
 *
 * Every case carries a POSITIVE CONTROL — the same write, aimed at this zone,
 * asserted to commit. Without them a selector that had been broken into always
 * returning a constant would sail through.
 */

import { render } from '@testing-library/react'
import { act, Profiler, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $detachedTiles } from '@/components/pane-shell/tile/detach'
import { group } from '@/components/pane-shell/tree/model'
import { $hiddenTreePanes, $layoutTree, $panesWithCloser, $treePaneEpochs } from '@/components/pane-shell/tree/store'
import { $tabSelection } from '@/components/pane-shell/tree/tab-selection'

import { registerTiles } from '../../tile/registry'

import { TreeGroup } from './tree-group'

const MINE = 'zone-mine'
const OTHER = 'zone-other'

const myZone = () => group(['alpha'], { active: 'alpha', id: MINE })

let disposeTiles: (() => void) | null = null

function commitsOf(node: ReactNode) {
  const commits = vi.fn()
  render(
    <Profiler id="zone" onRender={commits}>
      {node}
    </Profiler>
  )
  commits.mockClear()

  return commits
}

beforeEach(() => {
  $layoutTree.set(myZone())
  disposeTiles = registerTiles([
    { id: 'alpha', kind: 'tool', title: 'Alpha', placement: 'bottom', render: () => <p>alpha</p> },
    { id: 'beta', kind: 'tool', title: 'Beta', placement: 'bottom', render: () => <p>beta</p> }
  ])
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    bottom: 300,
    height: 300,
    left: 0,
    right: 400,
    toJSON: () => ({}),
    top: 0,
    width: 400,
    x: 0,
    y: 0
  }))
})

afterEach(() => {
  disposeTiles?.()
  disposeTiles = null
  $layoutTree.set(null)
  $hiddenTreePanes.set(new Set())
  $detachedTiles.set(new Map())
  $panesWithCloser.set(new Set())
  $treePaneEpochs.set({})
  $tabSelection.set(null)
  vi.restoreAllMocks()
})

describe('a zone ignores another zone', () => {
  it('$detachedTiles — another zone detaching its tile', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    act(() => $detachedTiles.set(new Map([['beta', 'Beta window']])))

    expect(commits).not.toHaveBeenCalled()

    // Positive control: ITS OWN pane detaching must still repaint (the zone
    // swaps the tile body for the "detached to another window" placeholder).
    act(() =>
      $detachedTiles.set(
        new Map([
          ['beta', 'Beta window'],
          ['alpha', 'Alpha window']
        ])
      )
    )

    expect(commits).toHaveBeenCalled()
  })

  it('$panesWithCloser — another zone registering a closer', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    act(() => $panesWithCloser.set(new Set(['beta'])))

    expect(commits).not.toHaveBeenCalled()

    act(() => $panesWithCloser.set(new Set(['beta', 'alpha'])))

    expect(commits).toHaveBeenCalled()
  })

  it('$treePaneEpochs — another zone reloading a tab', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    // Reload writes the WHOLE record, which is why an unnarrowed read repainted
    // every zone for a remount that concerned one pane.
    act(() => $treePaneEpochs.set({ beta: 1 }))

    expect(commits).not.toHaveBeenCalled()

    act(() => $treePaneEpochs.set({ alpha: 1, beta: 1 }))

    expect(commits).toHaveBeenCalled()
  })

  it('$tabSelection — a multi-tab selection living in another zone', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    act(() => $tabSelection.set({ anchor: 'beta', groupId: OTHER, ids: new Set(['beta', 'gamma']) }))

    expect(commits).not.toHaveBeenCalled()

    act(() => $tabSelection.set({ anchor: 'alpha', groupId: MINE, ids: new Set(['alpha', 'beta']) }))

    expect(commits).toHaveBeenCalled()
  })
})

describe('the zone still sees every transition it must', () => {
  // The failure mode a narrowing invites is the opposite one: a selector that is
  // quiet when it should have fired. Each of these moves a field the scalar has
  // to encode.
  it('follows a reload epoch that only advances', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    act(() => $treePaneEpochs.set({ alpha: 1 }))
    expect(commits).toHaveBeenCalledTimes(1)

    act(() => $treePaneEpochs.set({ alpha: 2 }))
    expect(commits).toHaveBeenCalledTimes(2)
  })

  it('follows the selection moving away from this zone', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    act(() => $tabSelection.set({ anchor: 'alpha', groupId: MINE, ids: new Set(['alpha', 'beta']) }))
    expect(commits).toHaveBeenCalledTimes(1)

    // Selection hops to another zone: this one must drop its highlight.
    act(() => $tabSelection.set({ anchor: 'beta', groupId: OTHER, ids: new Set(['beta', 'gamma']) }))
    expect(commits).toHaveBeenCalledTimes(2)
  })

  it('follows a detach being undone', () => {
    const commits = commitsOf(<TreeGroup node={myZone()} />)

    act(() => $detachedTiles.set(new Map([['alpha', 'Alpha window']])))
    expect(commits).toHaveBeenCalledTimes(1)

    act(() => $detachedTiles.set(new Map()))
    expect(commits).toHaveBeenCalledTimes(2)
  })
})
