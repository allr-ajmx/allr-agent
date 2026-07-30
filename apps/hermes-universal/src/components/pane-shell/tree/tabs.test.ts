/**
 * The chat TAB behaviours (MJX-51).
 *
 * These primitives all existed but were dead code — nothing called them, so
 * ⌘T/⌘W/⌃Tab/⌃1-9 never reached the tab strip. They are wired now, and each
 * returns a boolean so its caller can fall through to the non-tab meaning; the
 * fall-through cases matter as much as the hits.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { group, split } from '@/components/pane-shell/tree/model'
import {
  $layoutTree,
  activateTreeTabSlot,
  cycleTreeTabInFocusedZone,
  noteActiveTreeGroup,
  registerNewTabHandler,
  treeNewTabHandler,
  treeTabCloseTargets
} from '@/components/pane-shell/tree/store'
import { isChatPaneId, sessionTilePaneId, storedIdFromTilePane, WORKSPACE_PANE_ID } from '@/lib/pane-ids'

const CHAT_GROUP = 'chat-zone'
const TOOL_GROUP = 'tool-zone'

const tile = (id: string) => sessionTilePaneId(id)

/** A chat zone with `workspace` + N session tiles, beside a terminal zone. */
function seedTree(panes: string[], active = panes[0]) {
  $layoutTree.set(
    split('row', [
      group(panes, { active, id: CHAT_GROUP }),
      group(['terminal', 'logs'], { active: 'terminal', id: TOOL_GROUP })
    ])
  )
}

const activePaneOf = (groupId: string): string | undefined => {
  const tree = $layoutTree.get()

  const find = (node: typeof tree): string | undefined => {
    if (!node) {
      return undefined
    }

    if (node.type === 'group') {
      return node.id === groupId ? node.active : undefined
    }

    for (const child of node.children) {
      const hit = find(child)

      if (hit) {
        return hit
      }
    }

    return undefined
  }

  return find(tree)
}

beforeEach(() => {
  $layoutTree.set(null)
  noteActiveTreeGroup(null)
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
  it('advances and wraps within the focused chat zone', () => {
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

  // Returning false is how the caller knows to show the recent-session HUD
  // instead — the fall-through is the feature, not a failure.
  it('declines a lone tab, a non-chat zone, and an unfocused tree', () => {
    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(CHAT_GROUP)
    expect(cycleTreeTabInFocusedZone(1)).toBe(false)

    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(TOOL_GROUP)
    expect(cycleTreeTabInFocusedZone(1)).toBe(false)
    expect(activePaneOf(TOOL_GROUP)).toBe('terminal')

    noteActiveTreeGroup(null)
    expect(cycleTreeTabInFocusedZone(1)).toBe(false)
  })
})

describe('activateTreeTabSlot (⌃1-9)', () => {
  it('activates the Nth tab of the focused chat zone', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(activateTreeTabSlot(2)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('a'))

    expect(activateTreeTabSlot(3)).toBe(true)
    expect(activePaneOf(CHAT_GROUP)).toBe(tile('b'))
  })

  it('declines an out-of-range slot, a lone tab, and a non-chat zone', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(CHAT_GROUP)

    expect(activateTreeTabSlot(3)).toBe(false)
    expect(activateTreeTabSlot(0)).toBe(false)

    seedTree([WORKSPACE_PANE_ID])
    noteActiveTreeGroup(CHAT_GROUP)
    expect(activateTreeTabSlot(1)).toBe(false)

    // A terminal strip is not what ⌃N means, so it falls through to the Nth
    // recent SESSION rather than switching terminals.
    seedTree([WORKSPACE_PANE_ID, tile('a')])
    noteActiveTreeGroup(TOOL_GROUP)
    expect(activateTreeTabSlot(1)).toBe(false)
  })
})

describe('treeTabCloseTargets', () => {
  // Drives menu enablement: a verb that would close nothing is not offered.
  it('counts what each close verb would actually close', () => {
    seedTree([WORKSPACE_PANE_ID, tile('a'), tile('b')])

    const middle = treeTabCloseTargets(tile('a'))
    expect(middle.others).toBe(2) // workspace + b (nothing registered as uncloseable here)
    expect(middle.right).toBe(1) // b

    // The rightmost tab has nothing to its right.
    expect(treeTabCloseTargets(tile('b')).right).toBe(0)
  })

  it('reports nothing for a lone tab', () => {
    seedTree([WORKSPACE_PANE_ID])

    expect(treeTabCloseTargets(WORKSPACE_PANE_ID).others).toBe(0)
    expect(treeTabCloseTargets(WORKSPACE_PANE_ID).right).toBe(0)
  })
})

describe('new-tab handler seam', () => {
  // The renderer knows pane ids, not sessions, so the `+` reaches the session
  // store through a registration rather than an import.
  it('registers and unregisters', () => {
    expect(treeNewTabHandler()).toBeNull()

    let calls = 0

    const dispose = registerNewTabHandler(() => {
      calls++
    })

    treeNewTabHandler()?.()
    expect(calls).toBe(1)

    dispose()
    expect(treeNewTabHandler()).toBeNull()
  })
})
