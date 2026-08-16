/**
 * THE COLLAPSE VERBS (MJXHRM-373).
 *
 * `setPaneCollapsed` is the store half of the path this ticket is about:
 *
 *   ⌃` / statusbar toggle → $terminalOpen → bindPaneCollapse
 *     → setPaneCollapsed → toggleTreeGroupMinimized → node.minimized
 *     → the zone renderer stops showing the body
 *
 * The renderer half is covered by `renderer/collapse-keeps-body.test.tsx`. This
 * half had no test at all, and it is the half that decides WHICH axis a toggle
 * moves — collapse (the zone folds to a rail, the tab stays) versus hide (the
 * pane leaves the strip). A tool panel that started hiding instead of collapsing
 * would look identical in a screenshot and behave differently everywhere else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { group, split } from '@/components/pane-shell/tree/model'
import {
  $hiddenTreePanes,
  $layoutTree,
  registerPaneCloser,
  registerPaneOpener,
  restoreTreePane,
  setPaneCollapsed
} from '@/components/pane-shell/tree/store'
import { WORKSPACE_PANE_ID } from '@/lib/pane-ids'

import { registerTiles } from '../tile/registry'
import type { Tile } from '../tile/types'

const TOOL_GROUP = 'tool-zone'
const MAIN_GROUP = 'main-zone'

let disposeTiles: (() => void) | null = null

function register(ids: string[]) {
  const tiles: Tile[] = ids.map(id => ({
    chrome: id === WORKSPACE_PANE_ID ? { uncloseable: true } : { toolPanel: true },
    id,
    kind: 'tool',
    placement: id === WORKSPACE_PANE_ID ? 'main' : 'bottom',
    render: () => null,
    title: id
  }))

  disposeTiles = registerTiles(tiles)
}

/** The tool zone as the default layout has it: a zone of its own. */
function seedLone() {
  $layoutTree.set(
    split('row', [group([WORKSPACE_PANE_ID], { id: MAIN_GROUP }), group(['terminal'], { id: TOOL_GROUP })])
  )
  register([WORKSPACE_PANE_ID, 'terminal'])
}

/** Two tool panels stacked in ONE zone — one minimized flag, two toggles. */
function seedShared() {
  $layoutTree.set(
    split('row', [
      group([WORKSPACE_PANE_ID], { id: MAIN_GROUP }),
      group(['terminal', 'logs'], { active: 'terminal', id: TOOL_GROUP })
    ])
  )
  register([WORKSPACE_PANE_ID, 'terminal', 'logs'])
}

function zone(groupId: string) {
  const walk = (node: ReturnType<typeof $layoutTree.get>): null | { active?: string; minimized?: boolean } => {
    if (!node) {
      return null
    }

    if (node.type === 'group') {
      return node.id === groupId ? { active: node.active, minimized: node.minimized } : null
    }

    for (const child of node.children) {
      const hit = walk(child)

      if (hit) {
        return hit
      }
    }

    return null
  }

  return walk($layoutTree.get())
}

beforeEach(() => {
  $layoutTree.set(null)
  $hiddenTreePanes.set(new Set())
})

afterEach(() => {
  disposeTiles?.()
  disposeTiles = null
  $layoutTree.set(null)
  $hiddenTreePanes.set(new Set())
  registerPaneCloser('terminal')
})

describe('setPaneCollapsed', () => {
  it('folds the pane ZONE and leaves the pane in the tree', () => {
    seedLone()

    setPaneCollapsed('terminal', true)

    expect(zone(TOOL_GROUP)?.minimized).toBe(true)
    // COLLAPSE, not hide: the tab has to stay in its strip (that is what makes
    // the rail its own restore affordance), and the reveal axis has to stay out
    // of it — a hidden pane is a different contract with different lifetimes.
    expect($hiddenTreePanes.get().has('terminal')).toBe(false)
  })

  it('unfolds it again', () => {
    seedLone()

    setPaneCollapsed('terminal', true)
    setPaneCollapsed('terminal', false)

    expect(zone(TOOL_GROUP)?.minimized).toBe(false)
  })

  it('does not fold a SHARED zone on behalf of a pane that is not fronted', () => {
    // One minimized flag, two toggle stores. `logs` closing must not take the
    // terminal down with it — every boot re-applies both stores, so an inactive
    // toggle acting here re-collapsed the zone on every launch.
    seedShared()

    setPaneCollapsed('logs', true)

    expect(zone(TOOL_GROUP)?.minimized).toBeFalsy()
  })

  it('folds a shared TOOL zone when the fronted pane collapses', () => {
    seedShared()

    setPaneCollapsed('terminal', true)

    expect(zone(TOOL_GROUP)?.minimized).toBe(true)
  })
})

describe('restoreTreePane', () => {
  it('unfolds a zone whose store opener is already open', () => {
    // Minimized through the zone MENU, so the toggle store never changed. Its
    // opener is then a no-op — nanostores fire nothing on a same-value set — and
    // without the direct un-minimize the rail would be unclickable.
    seedLone()
    registerPaneOpener('terminal', () => {})

    setPaneCollapsed('terminal', true)
    restoreTreePane('terminal')

    expect(zone(TOOL_GROUP)?.minimized).toBe(false)
  })
})
