/**
 * THE DRAFT TILE — the new chat, as a tile like any other.
 *
 * `newSessionTab` used to do the opposite of what its name suggests: the draft
 * took over the main pane and the chat that was ALREADY there got parked into a
 * tile. Asking for a new chat moved a chat you had not asked about, and the new
 * one was the only chat in the app that was not a tile. These pin the inversion.
 *
 * The rotation is the other half: a draft has no stored id, so its tile carries
 * a placeholder one until the gateway issues a real one on first submit. That
 * hand-off has to be a RENAME (see tree/rename-pane.test.ts) — anything that
 * closes and reopens the pane sends it back through adoption, and the chat jumps
 * zones at the exact moment the user hits send.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerTiles } from '@/components/pane-shell/tile/registry'
import type { Tile } from '@/components/pane-shell/tile/types'
import { findGroupOfPane, group, split } from '@/components/pane-shell/tree/model'
import { $layoutTree } from '@/components/pane-shell/tree/store'
import { DRAFT_TILE_KEY, DRAFT_TILE_PANE_ID, sessionTilePaneId, WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { $activeStoredSessionId } from '@/store/session'
import {
  $activeSessionKey,
  type ClientSessionState,
  emptySessionState,
  publishSessionState
} from '@/store/session-state-types'
import {
  $sessionTiles,
  clearAllSessionStates,
  closeSessionTile,
  newSessionTab,
  tileRuntimeKey
} from '@/store/session-states'

const CHAT_GROUP = 'chat-zone'
const EXISTING = 'sess-existing'

let disposeTiles: (() => void) | null = null

/** The tree the tab strip lives in, plus a registered tile per pane. */
function seedTree(panes: string[], active = panes[0]) {
  disposeTiles?.()
  disposeTiles = registerTiles(
    panes.map<Tile>(id => ({ id, kind: 'chat', title: id, placement: 'main', render: () => null }))
  )

  $layoutTree.set(split('row', [group(['sessions']), group(panes, { active, id: CHAT_GROUP })]))
}

const seed = (key: string, patch: Partial<ClientSessionState> = {}) =>
  publishSessionState(key, { ...emptySessionState(patch.storedSessionId ?? key), runtimeSessionId: key, ...patch })

beforeEach(() => {
  clearAllSessionStates()
  $sessionTiles.set([])
  $activeStoredSessionId.set(null)
  $activeSessionKey.set('draft:1')
})

afterEach(() => {
  disposeTiles?.()
  disposeTiles = null
  $layoutTree.set(null)
  $sessionTiles.set([])
})

describe('newSessionTab', () => {
  it('opens the new chat as its own tile', () => {
    seedTree([WORKSPACE_PANE_ID])

    newSessionTab()

    expect($sessionTiles.get().map(t => t.storedSessionId)).toEqual([DRAFT_TILE_KEY])
  })

  it('leaves the chat that was already open exactly where it was', () => {
    // The whole point: starting a chat must not move an unrelated one.
    seedTree([WORKSPACE_PANE_ID])
    $activeStoredSessionId.set(EXISTING)

    newSessionTab()

    expect($sessionTiles.get().map(t => t.storedSessionId)).not.toContain(EXISTING)
  })

  it('stacks the draft into the zone the chat was asked from', () => {
    seedTree([WORKSPACE_PANE_ID])

    newSessionTab()

    expect($sessionTiles.get()[0]).toMatchObject({ anchor: WORKSPACE_PANE_ID, dir: 'center' })
  })

  it('fronts the existing draft instead of opening a second one', () => {
    seedTree([WORKSPACE_PANE_ID])

    newSessionTab()
    newSessionTab()

    expect($sessionTiles.get().filter(t => t.storedSessionId === DRAFT_TILE_KEY)).toHaveLength(1)
  })

  it('is never persisted — a draft names no session to restore', () => {
    seedTree([WORKSPACE_PANE_ID])

    newSessionTab()

    expect(JSON.stringify(window.localStorage.getItem('hermes.sessionTiles.v2') ?? '')).not.toContain(DRAFT_TILE_KEY)
  })
})

describe('tileRuntimeKey', () => {
  it('resolves the draft tile to the active placeholder slice', () => {
    // Without this the draft tile renders empty: its view resolves through here.
    $activeSessionKey.set('draft:7')

    expect(tileRuntimeKey(DRAFT_TILE_KEY)).toBe('draft:7')
  })

  it('resolves to nothing once the active session is a real one', () => {
    $activeSessionKey.set('runtime-abc')

    expect(tileRuntimeKey(DRAFT_TILE_KEY)).toBeNull()
  })
})

describe('the draft taking its issued id', () => {
  it('renames the tile in place, keeping its slot and its active flag', () => {
    seedTree([WORKSPACE_PANE_ID, DRAFT_TILE_PANE_ID], DRAFT_TILE_PANE_ID)
    $sessionTiles.set([{ anchor: WORKSPACE_PANE_ID, dir: 'center', storedSessionId: DRAFT_TILE_KEY }])

    // First submit: the slice goes from "no stored id" to an issued one.
    seed('draft:1', { storedSessionId: null })
    seed('draft:1', { storedSessionId: 'sess-new' })

    const zone = findGroupOfPane($layoutTree.get()!, sessionTilePaneId('sess-new'))

    expect(zone?.id).toBe(CHAT_GROUP)
    expect(zone?.panes).toEqual([WORKSPACE_PANE_ID, sessionTilePaneId('sess-new')])
    expect(zone?.active).toBe(sessionTilePaneId('sess-new'))
    expect($sessionTiles.get().map(t => t.storedSessionId)).toEqual(['sess-new'])
  })

  it('drops the draft rather than duplicating a session that already has a tab', () => {
    seedTree([WORKSPACE_PANE_ID, DRAFT_TILE_PANE_ID])
    $sessionTiles.set([
      { storedSessionId: EXISTING },
      { anchor: WORKSPACE_PANE_ID, dir: 'center', storedSessionId: DRAFT_TILE_KEY }
    ])

    seed('draft:1', { storedSessionId: null })
    seed('draft:1', { storedSessionId: EXISTING })

    expect($sessionTiles.get().map(t => t.storedSessionId)).toEqual([EXISTING])
  })

  it('does nothing when there is no draft tile open', () => {
    seedTree([WORKSPACE_PANE_ID])
    $sessionTiles.set([])

    seed('draft:1', { storedSessionId: null })
    seed('draft:1', { storedSessionId: 'sess-new' })

    expect($sessionTiles.get()).toEqual([])
  })
})

describe('closing the draft', () => {
  it('leaves no reopen entry — there is no chat to bring back', () => {
    seedTree([WORKSPACE_PANE_ID, DRAFT_TILE_PANE_ID])
    $sessionTiles.set([{ storedSessionId: DRAFT_TILE_KEY }])

    closeSessionTile(DRAFT_TILE_KEY)

    expect($sessionTiles.get()).toEqual([])
  })
})
