/**
 * "New session" as ONE act (MJXHRM-6).
 *
 * The bug was never that a session failed to be created — it was that the three
 * things which make a new chat usable (it is routed to, its zone is the focused
 * one, its composer has the caret) were spread unevenly across six entry points,
 * and ⌘T had none of them. These tests pin the end state, not the steps, so the
 * entry points cannot drift apart again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The focus bus and the router are the two seams this module reaches through;
// spying on them is how "the caret went to the new chat" is observable in a
// headless test.
vi.mock('@/app/chat/composer/focus', () => ({ requestComposerFocus: vi.fn() }))
vi.mock('@/lib/route-nav', () => ({ navigateTo: vi.fn() }))

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { NEW_CHAT_ROUTE } from '@/app/routes'
import { registerTiles } from '@/components/pane-shell/tile/registry'
import type { Tile } from '@/components/pane-shell/tile/types'
import { group, split } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $layoutTree, noteActiveTreeGroup } from '@/components/pane-shell/tree/store'
import { DRAFT_TILE_KEY, isChatPaneId, sessionTilePaneId, WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { navigateTo } from '@/lib/route-nav'
import { $activeStoredSessionId } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

import { startNewSession, startNewSessionTab } from './new-session'

const CHAT_GROUP = 'chat-zone'
const TOOL_GROUP = 'tool-zone'

let disposeTiles: (() => void) | null = null

/** The verbs resolve visibility through the tile registry, so every pane id in
 *  the tree needs a tile or it reads as absent and is never a tab. */
function seedTree(panes: string[], active = panes[0]) {
  const ids = [...panes, 'terminal']

  disposeTiles?.()
  disposeTiles = registerTiles(
    ids.map<Tile>(id => ({
      id,
      kind: isChatPaneId(id) ? 'chat' : 'tool',
      title: id,
      render: () => null,
      placement: isChatPaneId(id) ? 'main' : 'bottom',
      chrome: id === WORKSPACE_PANE_ID ? { uncloseable: true } : undefined
    }))
  )

  $layoutTree.set(
    split('row', [
      group(panes, { active, id: CHAT_GROUP }),
      group(['terminal'], { active: 'terminal', id: TOOL_GROUP })
    ])
  )
}

/** The chat zone as the tree currently holds it. */
const chatZone = (): { active?: string; panes: string[] } => {
  const tree = $layoutTree.get()

  const find = (node: typeof tree): null | { active?: string; panes: string[] } => {
    if (!node) {
      return null
    }

    if (node.type === 'group') {
      return node.id === CHAT_GROUP ? { active: node.active, panes: node.panes } : null
    }

    return node.children.reduce<null | { active?: string; panes: string[] }>((hit, child) => hit ?? find(child), null)
  }

  return find($layoutTree.get()) ?? { panes: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
  $sessionTiles.set([])
  $activeStoredSessionId.set(null)
  // The user was last interacting with the terminal zone — so "the new session's
  // zone is the focused one" is a real move, not the state we started in.
  noteActiveTreeGroup(TOOL_GROUP)
  seedTree([WORKSPACE_PANE_ID])
})

describe('startNewSession', () => {
  it('routes to the chat, focuses the workspace zone and the composer', () => {
    startNewSession()

    expect(navigateTo).toHaveBeenCalledWith(NEW_CHAT_ROUTE)
    expect($activeTreeGroup.get()).toBe(CHAT_GROUP)
    expect(requestComposerFocus).toHaveBeenCalledWith('main')
  })

  it('leaves the caret in main even with nothing to park', () => {
    startNewSession()

    expect($sessionTiles.get()).toEqual([])
    expect($activeStoredSessionId.get()).toBeNull()
    expect(requestComposerFocus).toHaveBeenCalledWith('main')
  })
})

describe('startNewSessionTab', () => {
  beforeEach(() => {
    $activeStoredSessionId.set('parked')
    seedTree([WORKSPACE_PANE_ID])
  })

  // Inverted in the draft-tile change: it is the NEW chat that gets a tile now,
  // and the chat already open stays put. Parking it was the old behaviour, and
  // it meant asking for a new chat moved a chat you had not asked about.
  it('opens the new chat as a tile and leaves the open one alone', () => {
    startNewSessionTab()

    expect($sessionTiles.get().map(t => t.storedSessionId)).toEqual([DRAFT_TILE_KEY])
    expect($activeStoredSessionId.get()).toBeNull()
  })

  // The ticket's sharpest requirement: focus must not land on the session that
  // was just moved out of the way. Seeded with the tile's pane ALREADY fronted —
  // the shape the React pane mirror leaves behind, and the one where "reveal the
  // workspace" is doing real work rather than agreeing with the initial state.
  it('fronts the new chat, never the session it just parked', () => {
    const parked = sessionTilePaneId('parked')

    seedTree([WORKSPACE_PANE_ID, parked], parked)
    expect(chatZone().active).toBe(parked)

    startNewSessionTab()

    expect(chatZone().active).toBe(WORKSPACE_PANE_ID)
  })

  // `newSession()` homes the focused zone to null on its way through. Claiming
  // the zone afterwards is what keeps ⌥1-9 and ⌃Tab working on the two tabs the
  // user is now looking at — they read $activeTreeGroup raw, with no fallback.
  it('claims the workspace zone rather than leaving it null', () => {
    startNewSessionTab()

    expect($activeTreeGroup.get()).toBe(CHAT_GROUP)
  })

  it('routes to the chat so ⌘T from a page view is visible', () => {
    startNewSessionTab()

    expect(navigateTo).toHaveBeenCalledWith(NEW_CHAT_ROUTE)
  })

  it('asks for the caret only once the tile exists', () => {
    let tilesWhenFocused: string[] = []

    vi.mocked(requestComposerFocus).mockImplementation(() => {
      tilesWhenFocused = $sessionTiles.get().map(t => t.storedSessionId ?? '')
    })

    startNewSessionTab()

    expect(tilesWhenFocused).toEqual([DRAFT_TILE_KEY])
  })

  // The new chat lives in a TILE, and a tile owns its own composer scope. Asking
  // for `'main'` here would put the caret in whatever chat the workspace happens
  // to be showing — a different conversation than the one just opened.
  it('puts the caret in the draft TILE composer, not main', () => {
    startNewSessionTab()

    expect(requestComposerFocus).toHaveBeenCalledWith(`tile:${DRAFT_TILE_KEY}`)
  })
})
