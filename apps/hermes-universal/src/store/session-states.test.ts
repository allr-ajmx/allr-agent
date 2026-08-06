import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerTiles } from '@/components/pane-shell/tile/registry'
import type { Tile } from '@/components/pane-shell/tile/types'
import { group, split } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $layoutTree, noteActiveTreeGroup } from '@/components/pane-shell/tree/store'
import { isChatPaneId, sessionTilePaneId, WORKSPACE_PANE_ID } from '@/lib/pane-ids'
import { $activeStoredSessionId } from '@/store/session'
import {
  $activeSessionKey,
  $sessionStates,
  aliasStoredSessionId,
  dropSessionState,
  emptySessionState,
  ensureSessionSlice,
  publishSessionState,
  rekeySession,
  runtimeKeyForStoredSession,
  updateSession
} from '@/store/session-state-types'
import {
  $sessionTiles,
  clearAllSessionStates,
  focusOpenSession,
  focusWorkspaceSession,
  MAX_CACHED_SESSIONS,
  pruneSessionStates
} from '@/store/session-states'

const seed = (key: string, patch: Partial<ReturnType<typeof emptySessionState>> = {}) =>
  publishSessionState(key, { ...emptySessionState(patch.storedSessionId ?? key), runtimeSessionId: key, ...patch })

beforeEach(() => {
  clearAllSessionStates()
  $activeSessionKey.set('active')
  seed('active')
})

describe('rekeySession', () => {
  // A subscriber that saw a frame with neither key would render a chat that
  // briefly does not exist — hence the single `.set`.
  it('moves a slice atomically', () => {
    seed('draft:1', { runtimeSessionId: null, storedSessionId: null, messages: [] })

    const frames: boolean[] = []

    const unsubscribe = $sessionStates.subscribe(states => {
      frames.push('draft:1' in states || 'runtime-1' in states)
    })

    rekeySession('draft:1', 'runtime-1', { runtimeSessionId: 'runtime-1', storedSessionId: 'stored-1' })
    unsubscribe()

    expect(frames.every(Boolean)).toBe(true)
    expect($sessionStates.get()['draft:1']).toBeUndefined()
    expect($sessionStates.get()['runtime-1']).toMatchObject({ runtimeSessionId: 'runtime-1' })
  })

  it('carries the active pointer with the slice', () => {
    seed('draft:2', { runtimeSessionId: null })
    $activeSessionKey.set('draft:2')

    rekeySession('draft:2', 'runtime-2')

    expect($activeSessionKey.get()).toBe('runtime-2')
  })

  it('leaves the active pointer alone when a background session rekeys', () => {
    seed('hydrating:x', { storedSessionId: 'x' })

    rekeySession('hydrating:x', 'runtime-x')

    expect($activeSessionKey.get()).toBe('active')
  })
})

describe('stored id → key resolution', () => {
  it('resolves a live session and forgets a dropped one', () => {
    seed('runtime-1', { storedSessionId: 'stored-1' })
    expect(runtimeKeyForStoredSession('stored-1')).toBe('runtime-1')

    dropSessionState('runtime-1')
    expect(runtimeKeyForStoredSession('stored-1')).toBeNull()
  })

  // MJX-133: an auto-compaction rotates the stored id, but bubbles, tiles,
  // layout pane ids and the persisted blobs all still name the OLD one.
  it('keeps a pre-rotation stored id resolving after a compaction', () => {
    seed('runtime-1', { storedSessionId: 'stored-old' })

    updateSession('runtime-1', state => ({ ...state, storedSessionId: 'stored-new' }))

    expect(runtimeKeyForStoredSession('stored-new')).toBe('runtime-1')
    expect(runtimeKeyForStoredSession('stored-old')).toBe('runtime-1')
  })

  it('carries aliases across a rekey', () => {
    seed('hydrating:a', { storedSessionId: 'stored-old' })
    updateSession('hydrating:a', state => ({ ...state, storedSessionId: 'stored-new' }))

    rekeySession('hydrating:a', 'runtime-a')

    expect(runtimeKeyForStoredSession('stored-old')).toBe('runtime-a')
    expect(runtimeKeyForStoredSession('stored-new')).toBe('runtime-a')
  })

  it('aliases a lineage root onto an open session', () => {
    seed('runtime-1', { storedSessionId: 'stored-1' })
    aliasStoredSessionId('lineage-root', 'stored-1')

    expect(runtimeKeyForStoredSession('lineage-root')).toBe('runtime-1')
  })
})

describe('updateSession', () => {
  // The old version returned `undefined` cast to a state on a miss — harmless
  // while only tiles used the map, a crash once the visible chat reads from it.
  it('creates a missing slice rather than returning undefined', () => {
    const next = updateSession('never-seen', state => ({ ...state, statusLine: 'hi' }))

    expect(next.statusLine).toBe('hi')
    expect($sessionStates.get()['never-seen']).toBeDefined()
  })

  it('does not republish when the updater returns the same state', () => {
    let frames = 0

    const unsubscribe = $sessionStates.subscribe(() => {
      frames++
    })

    updateSession('active', state => state)
    unsubscribe()

    expect(frames).toBe(1) // the subscribe call itself, no write
  })
})

describe('pruneSessionStates', () => {
  const fill = (count: number, patch: Partial<ReturnType<typeof emptySessionState>> = {}) => {
    for (let i = 0; i < count; i++) {
      seed(`idle-${i}`, { lastTouchedAt: i, ...patch })
    }
  }

  it('evicts the least recently touched once over the cap', () => {
    fill(MAX_CACHED_SESSIONS + 3)
    pruneSessionStates()

    expect(Object.keys($sessionStates.get())).toHaveLength(MAX_CACHED_SESSIONS)
    expect($sessionStates.get()['idle-0']).toBeUndefined()
    expect($sessionStates.get()['idle-1']).toBeUndefined()
  })

  it('never evicts the session on screen', () => {
    fill(MAX_CACHED_SESSIONS + 5)
    // `active` was seeded first, so it is the oldest by lastTouchedAt.
    pruneSessionStates()

    expect($sessionStates.get().active).toBeDefined()
  })

  // Dropping a live turn to respect a cache bound would be the wrong trade — an
  // over-cap map full of working sessions simply stays over cap.
  it('never evicts a session that is working or waiting on input', () => {
    fill(MAX_CACHED_SESSIONS + 4, { busy: true })
    pruneSessionStates()

    expect(Object.keys($sessionStates.get()).length).toBeGreaterThan(MAX_CACHED_SESSIONS)

    clearAllSessionStates()
    $activeSessionKey.set('active')
    seed('active')
    fill(MAX_CACHED_SESSIONS + 4, { needsInput: true })
    pruneSessionStates()

    expect(Object.keys($sessionStates.get()).length).toBeGreaterThan(MAX_CACHED_SESSIONS)
  })

  it('never evicts a draft — its unsent text cannot be re-fetched', () => {
    ensureSessionSlice('draft:9', { runtimeSessionId: null })
    fill(MAX_CACHED_SESSIONS + 4)
    pruneSessionStates()

    expect($sessionStates.get()['draft:9']).toBeDefined()
  })
})

/**
 * FOCUSING A CHAT that is already on screen (MJXHRM-6).
 *
 * `focusWorkspaceSession` is the workspace half of `focusOpenSession`, extracted
 * so a NEW session and an EXISTING one land in the same end state. Both name the
 * zone rather than `null`: the tab verbs read `$activeTreeGroup` raw, so a null
 * zone leaves ⌥1-9 and ⌃Tab inert on tabs the user is looking at.
 */
describe('focusWorkspaceSession', () => {
  const CHAT_GROUP = 'chat-zone'
  const TOOL_GROUP = 'tool-zone'

  let disposeTiles: (() => void) | null = null

  const seedTree = (panes: string[], active = panes[0]) => {
    disposeTiles?.()
    disposeTiles = registerTiles(
      [...panes, 'terminal'].map<Tile>(id => ({
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

  beforeEach(() => {
    $sessionTiles.set([])
    $activeStoredSessionId.set(null)
    noteActiveTreeGroup(TOOL_GROUP)
  })

  afterEach(() => {
    disposeTiles?.()
    disposeTiles = null
    $layoutTree.set(null)
  })

  it('claims the workspace zone when the chat is alone in it', () => {
    seedTree([WORKSPACE_PANE_ID])

    focusWorkspaceSession()

    expect($activeTreeGroup.get()).toBe(CHAT_GROUP)
  })

  it('fronts the workspace tab when tiles share its zone', () => {
    const tile = sessionTilePaneId('other')
    seedTree([WORKSPACE_PANE_ID, tile], tile)

    focusWorkspaceSession()

    expect($activeTreeGroup.get()).toBe(CHAT_GROUP)
  })

  it('survives a tree that does not exist yet (mobile has no panes)', () => {
    $layoutTree.set(null)

    expect(() => focusWorkspaceSession()).not.toThrow()
    expect($activeTreeGroup.get()).toBeNull()
  })

  // The main-pane branch used to leave the zone null, so clicking the sidebar
  // row of the chat already in main left ⌃Tab unable to see its own strip.
  it('is what focusOpenSession uses for the chat already in main', () => {
    seedTree([WORKSPACE_PANE_ID])
    $activeStoredSessionId.set('loaded')

    expect(focusOpenSession('loaded')).toBe(true)
    expect($activeTreeGroup.get()).toBe(CHAT_GROUP)
  })
})
