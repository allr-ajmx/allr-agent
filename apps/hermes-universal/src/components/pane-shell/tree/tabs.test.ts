/**
 * The TAB verbs (MJX-51, made generic in MJXHRM-168).
 *
 * Each returns a boolean so its caller can fall through to the non-tab meaning;
 * the fall-through cases matter as much as the hits.
 *
 * Two things changed in MJXHRM-168, and they are the user-visible point of that
 * step, so they are pinned here:
 *  - the verbs are no longer scoped to CHAT strips, so a zone with two
 *    terminals stacked in it responds to ⌥2 and ⌃Tab like any other strip;
 *  - they index the SHOWN tiles, so a hidden tile earlier in the zone no longer
 *    shifts every slot by one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { group, split } from '@/components/pane-shell/tree/model'
import {
  $layoutTree,
  activateTreeTabSlot,
  closeFocusedTabInZone,
  cycleTreeTabInFocusedZone,
  noteActiveTreeGroup,
  noteHoveredTreeGroup,
  setTreePaneHidden,
  treeTabCloseTargets
} from '@/components/pane-shell/tree/store'
import { isChatPaneId, sessionTilePaneId, storedIdFromTilePane, WORKSPACE_PANE_ID } from '@/lib/pane-ids'

import { registerTiles } from '../tile/registry'
import type { Tile } from '../tile/types'

const CHAT_GROUP = 'chat-zone'
const TOOL_GROUP = 'tool-zone'

const tile = (id: string) => sessionTilePaneId(id)

let disposeTiles: (() => void) | null = null

/** Register a tile per pane id. The verbs resolve visibility through the
 *  registry now, so an unregistered pane id is `absent` and never a tab. */
function registerFor(ids: string[]) {
  disposeTiles?.()

  const tiles: Tile[] = ids.map(id => ({
    id,
    kind: isChatPaneId(id) ? 'chat' : 'tool',
    title: id,
    render: () => null,
    placement: isChatPaneId(id) ? 'main' : 'bottom',
    chrome: id === WORKSPACE_PANE_ID ? { uncloseable: true } : undefined
  }))

  disposeTiles = registerTiles(tiles)
}

/** A chat zone with `workspace` + N session tiles, beside a terminal zone. */
function seedTree(panes: string[], active = panes[0]) {
  $layoutTree.set(
    split('row', [
      group(panes, { active, id: CHAT_GROUP }),
      group(['terminal', 'logs'], { active: 'terminal', id: TOOL_GROUP })
    ])
  )
  registerFor([...panes, 'terminal', 'logs'])
}

const groupIn = (groupId: string) => {
  const tree = $layoutTree.get()

  const find = (node: typeof tree): null | { active?: string; panes: string[] } => {
    if (!node) {
      return null
    }

    if (node.type === 'group') {
      return node.id === groupId ? { active: node.active, panes: node.panes } : null
    }

    for (const child of node.children) {
      const hit = find(child)

      if (hit) {
        return hit
      }
    }

    return null
  }

  return find(tree)
}

const activePaneOf = (groupId: string): string | undefined => groupIn(groupId)?.active
const panesOf = (groupId: string): string[] => groupIn(groupId)?.panes ?? []

beforeEach(() => {
  $layoutTree.set(null)
  noteActiveTreeGroup(null)
  // Both rungs of the ladder are module atoms; every test above this line is
  // asserting the FOCUSED rung, which only holds while hover is clear.
  noteHoveredTreeGroup(null)
})

afterEach(() => {
  disposeTiles?.()
  disposeTiles = null
  setTreePaneHidden(tile('a'), false)
  setTreePaneHidden('logs', false)
})

describe('pane id vocabulary', () => {
  it('round-trips a session tile id', () => {
    expect(storedIdFromTilePane(tile('abc'))).toBe('abc')
    expect(storedIdFromTilePane(WORKSPACE_PANE_ID)).toBeNull()
    expect(storedIdFromTilePane('terminal')).toBeNull()
  })

  it('recognises the panes that render a chat', () => {
    expect(isChatPaneId(WORKSPACE_PANE_ID)).toBe(true)
    expect(isChatPaneId(tile('abc'))).toBe(true)
    expect(isChatPaneId('terminal')).toBe(false)
    expect(isChatPaneId('files')).toBe(false)
  })
})

describe('cycleTreeTabInFocusedZone (⌃Tab)', () => {
  it('advances and wraps within the focused zone', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('a'))

    expect(cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('b'))

    // Wraps rather than stopping at the end.
    expect(cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(WORKSPACE_PANE_ID)
  })

  it('steps backwards too', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(cycleTreeTabInFocusedZone(-1)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('b'))
  })

  // THE FIX. A tool strip is a tab strip; it used to render tabs the keyboard
  // could not reach.
  it('cycles a NON-chat strip — two tool panels stacked in a zone', () => {
    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(TOOL_GROUP)

    expect(cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(activePaneOf(TOOL_GROUP)).toBe('logs')
  })

  // Returning false is how the caller knows to show the recent-session HUD
  // instead — the fall-through is the feature, not a failure.
  it('declines a lone tab and an unfocused tree', () => {
    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(CHAT_GROUP)
    expect(cycleTreeTabInFocusedZone(1)).toBe(false)

    noteActiveTreeGroup(null)
    expect(cycleTreeTabInFocusedZone(1)).toBe(false)
  })

  it('declines a zone whose second tile is hidden — one visible tab is not a strip', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(CHAT_GROUP)
    setTreePaneHidden(tile('a'), true)

    expect(cycleTreeTabInFocusedZone(1)).toBe(false)
  })
})

describe('activateTreeTabSlot (⌥1-9)', () => {
  it('activates the Nth tab of the focused zone', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('a'))

    expect(activateTreeTabSlot(3)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('b'))
  })

  // THE OTHER FIX. Slots used to index `group.panes` raw, so a hidden tile
  // earlier in the zone shifted every slot by one and ⌥2 landed on the wrong
  // tab — or, at the end of the strip, on nothing.
  it('counts VISIBLE tabs, not raw panes', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    noteActiveTreeGroup(CHAT_GROUP)
    setTreePaneHidden(tile('a'), true)

    // Slot 2 is now `b` — the 2nd tab the strip actually draws.
    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('b'))

    // And slot 3 is past the end, rather than selecting an invisible tile.
    expect(activateTreeTabSlot(3)).toBe(false)
  })

  it('activates a NON-chat strip — the tool stack responds to ⌥2', () => {
    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(TOOL_GROUP)

    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(TOOL_GROUP)).toBe('logs')
  })

  it('declines an out-of-range slot and a lone tab', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(activateTreeTabSlot(3)).toBe(false)
    expect(activateTreeTabSlot(0)).toBe(false)

    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(CHAT_GROUP)
    expect(activateTreeTabSlot(1)).toBe(false)
  })

  it('declines an unregistered pane id — a plugin that has not loaded is not a tab', () => {
    $layoutTree.set(
      split('row', [group([WORKSPACE_PANE_ID, 'plugin:absent'], { active: WORKSPACE_PANE_ID, id: CHAT_GROUP })])
    )
    registerFor([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(activateTreeTabSlot(2)).toBe(false)
  })
})

describe('closeFocusedTabInZone (⌘W)', () => {
  it('closes the FOCUSED zone tab, leaving the chat zone alone', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(TOOL_GROUP)

    expect(closeFocusedTabInZone()).toBe(true)
    expect(panesOf(TOOL_GROUP)).not.toContain('terminal')
    // The chat zone, which ⌘W used to target no matter what had focus.
    expect(panesOf(CHAT_GROUP)).toEqual([WORKSPACE_PANE_ID, tile('a')])
  })

  it('closes the focused chat zone tab when that is what has focus', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')], tile('a'))
    noteActiveTreeGroup(CHAT_GROUP)

    expect(closeFocusedTabInZone()).toBe(true)
    expect(panesOf(CHAT_GROUP)).toEqual([WORKSPACE_PANE_ID])
  })

  it('is a no-op on an uncloseable tab — ⌘W never closes the window', () => {
    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(closeFocusedTabInZone()).toBe(false)
    expect(panesOf(CHAT_GROUP)).toEqual([WORKSPACE_PANE_ID])
  })
})

/**
 * THE POINTER RUNG. Every verb above resolves its zone through one ladder —
 * hovered, then focused, then the main tile's — and each rung has to be able to
 * SERVE the verb before it claims the keys. Ported from upstream's
 * `hovered-zone-tabs.test.ts` (15a55cbff1), which the original port left
 * behind: the hover rung shipped with no coverage at all, which is how a
 * headline feature ends up wired but dead.
 */
describe('the hovered zone outranks the focused one', () => {
  it('⌥2 switches the zone under the POINTER while the other holds focus', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    noteActiveTreeGroup(CHAT_GROUP)
    noteHoveredTreeGroup(TOOL_GROUP)

    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(TOOL_GROUP)).toBe('logs')
    // The focused zone is untouched — the pointer won the target, not both.
    expect(activePaneOf(CHAT_GROUP)).toBe(WORKSPACE_PANE_ID)

    // Same key, pointer moved: the other zone's slot 2.
    noteHoveredTreeGroup(CHAT_GROUP)
    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('a'))
  })

  it('⌃Tab follows the pointer the same way', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(CHAT_GROUP)
    noteHoveredTreeGroup(TOOL_GROUP)

    expect(cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(activePaneOf(TOOL_GROUP)).toBe('logs')
    expect(activePaneOf(CHAT_GROUP)).toBe(WORKSPACE_PANE_ID)
  })

  it('⌘W closes the hovered zone tab, not the focused one', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')], tile('a'))
    noteActiveTreeGroup(CHAT_GROUP)
    noteHoveredTreeGroup(TOOL_GROUP)

    expect(closeFocusedTabInZone()).toBe(true)
    expect(panesOf(TOOL_GROUP)).not.toContain('terminal')
    expect(panesOf(CHAT_GROUP)).toEqual([WORKSPACE_PANE_ID, tile('a')])
  })

  // The rung has to be ELIGIBLE, not merely hovered — otherwise a pointer
  // parked on a zone that cannot serve the verb swallows the keystroke.
  it('hands the verb down when the hovered zone cannot serve it', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    // The tool zone collapsed to one tab: nothing to cycle or index there.
    setTreePaneHidden('logs', true)
    noteActiveTreeGroup(CHAT_GROUP)
    noteHoveredTreeGroup(TOOL_GROUP)

    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('a'))

    expect(cycleTreeTabInFocusedZone(1)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('b'))
  })

  it('reverts to the focused zone once the pointer leaves every zone', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(CHAT_GROUP)
    noteHoveredTreeGroup(TOOL_GROUP)
    // pointerleave / window blur clear the override (trackActiveTreeGroup).
    noteHoveredTreeGroup(null)

    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('a'))
    expect(activePaneOf(TOOL_GROUP)).toBe('terminal')
  })
})

describe('treeTabCloseTargets', () => {
  // Drives menu enablement: a verb that would close nothing is not offered.
  it('counts what each close verb would actually close', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])

    const middle = treeTabCloseTargets(tile('a'))
    expect(middle.others).toBe(1) // b — the workspace declares `uncloseable`
    expect(middle.right).toBe(1) // b

    // The rightmost tab has nothing to its right.
    expect(treeTabCloseTargets(tile('b')).right).toBe(0)
  })

  it('reports nothing for a lone uncloseable tab', () => {
    seedTree([WORKSPACE_PANE_ID])

    expect(treeTabCloseTargets(WORKSPACE_PANE_ID).others).toBe(0)
    expect(treeTabCloseTargets(WORKSPACE_PANE_ID).right).toBe(0)
  })
})
