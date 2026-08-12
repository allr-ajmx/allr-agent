/**
 * MJXHRM-386 — a tab must not lose a session's identity just because the
 * recents page has scrolled past it.
 *
 * `$sessions` is a paginated window, and every surface that rendered a session
 * by id treated a miss in it as "unknown": a tile tab fell back to the literal
 * `'Session'`, the main tab read `'New session'` over a named chat, and both
 * lost their colour — because the colour resolver needs a `SessionInfo` and
 * there was none to hand it. Widening the lookup is the whole fix; the colour
 * then falls out of `sessionColorFor` unchanged.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'
import type { SessionInfo } from '@/types/hermes'

import { $pinnedSessionIds } from './layout'
import { $projectTree } from './projects'
import { $activeStoredSessionId, $sessions } from './session'
import { $sessionColorOverrides, sessionColorFor, setSessionColorOverride } from './session-color'
import { sessionRowFor, toggleSelectedPin, useSessionRowScalars } from './session-lookup'

const row = (id: string, title: string, lineageRoot?: string): SessionInfo =>
  ({ id, title, ...(lineageRoot ? { _lineage_root_id: lineageRoot } : {}) }) as unknown as SessionInfo

const tree = (sessions: SessionInfo[], previews: SessionInfo[] = []): SidebarProjectTree =>
  ({
    id: 'p1',
    label: 'Project',
    path: '/repo',
    repos: [
      {
        id: 'r1',
        label: 'repo',
        path: '/repo',
        groups: [{ id: 'g1', label: 'main', path: '/repo', sessions }],
        sessionCount: sessions.length
      }
    ],
    sessionCount: sessions.length,
    previewSessions: previews
  }) as SidebarProjectTree

afterEach(() => {
  $sessions.set([])
  $projectTree.set([])
  $pinnedSessionIds.set([])
  $activeStoredSessionId.set(null)
  $sessionColorOverrides.set({})
})

describe('sessionRowFor', () => {
  it('prefers the loaded recents row', () => {
    $sessions.set([row('a', 'Loaded')])
    $projectTree.set([tree([row('a', 'Stale tree copy')])])

    expect(sessionRowFor('a')?.title).toBe('Loaded')
  })

  it('falls back to the pinned cache once the row leaves the recents page', () => {
    // The cache is populated by pinning a session that IS loaded...
    $pinnedSessionIds.set(['a'])
    $sessions.set([row('a', 'Pinned chat')])

    // ...and survives the page moving on, which is the case that used to render
    // as the bare string 'Session'.
    $sessions.set([row('z', 'Something else')])

    expect(sessionRowFor('a')?.title).toBe('Pinned chat')
  })

  it('falls back to the project tree, including a project overview preview', () => {
    $projectTree.set([tree([row('deep', 'Deep in a lane')], [row('preview', 'Overview preview')])])

    expect(sessionRowFor('deep')?.title).toBe('Deep in a lane')
    expect(sessionRowFor('preview')?.title).toBe('Overview preview')
  })

  it('is null for a genuinely unknown id, and for no id at all', () => {
    $sessions.set([row('a', 'A')])

    expect(sessionRowFor('nope')).toBeNull()
    expect(sessionRowFor(null)).toBeNull()
    expect(sessionRowFor('')).toBeNull()
  })

  // Auto-compression rotates the live id and the surfaces keep the one they were
  // opened with, so every source has to be searched by LINEAGE, not by `id ===`.
  // The fallbacks are the ones that matter: an old, compacted conversation is
  // exactly the sort that has aged out of the recents page.
  it('answers to a pre-rotation id in every source', () => {
    $sessions.set([row('tip-1', 'From recents', 'root-1')])
    expect(sessionRowFor('root-1')?.title).toBe('From recents')

    $pinnedSessionIds.set(['root-2'])
    $sessions.set([row('tip-2', 'From the pinned cache', 'root-2')])
    $sessions.set([])
    expect(sessionRowFor('root-2')?.title).toBe('From the pinned cache')

    $projectTree.set([tree([row('tip-3', 'From the tree', 'root-3')])])
    expect(sessionRowFor('root-3')?.title).toBe('From the tree')
  })
})

/**
 * The `session.togglePin` keybind. Pins are keyed by the DURABLE lineage id, and
 * this used to resolve the row out of `$sessions` alone — so for a session past
 * the recents page it fell back to whatever raw id was active, which after a
 * compaction is the live tip rather than the lineage root the sidebar looks
 * under.
 */
describe('toggleSelectedPin', () => {
  it('pins an out-of-recents session under its durable lineage id', () => {
    $activeStoredSessionId.set('tip-9')
    $projectTree.set([tree([row('tip-9', 'Aged out and compacted', 'root-9')])])

    toggleSelectedPin()

    expect($pinnedSessionIds.get()).toEqual(['root-9'])
  })

  it('unpins the pin it would have created, not a second one beside it', () => {
    $activeStoredSessionId.set('tip-9')
    $projectTree.set([tree([row('tip-9', 'Aged out and compacted', 'root-9')])])
    $pinnedSessionIds.set(['root-9'])

    toggleSelectedPin()

    expect($pinnedSessionIds.get()).toEqual([])
  })

  it('falls back to the raw id when no source has ever seen the session', () => {
    $activeStoredSessionId.set('unknown-1')

    toggleSelectedPin()

    expect($pinnedSessionIds.get()).toEqual(['unknown-1'])
  })

  it('does nothing with no session on screen', () => {
    $activeStoredSessionId.set(null)

    toggleSelectedPin()

    expect($pinnedSessionIds.get()).toEqual([])
  })
})

/**
 * `pinId` is the DURABLE key both the pin verbs and the colour picker write
 * under, so it is the write half of "a colour is a function of a stable
 * identity". The picker resolved it out of `$sessions` alone, which for a
 * compacted session past the recents page yielded the raw live tip — while
 * `sessionColorFor` reads the override under the lineage root. The colour was
 * written to a key nothing reads.
 */
describe('useSessionRowScalars — the durable key the colour picker writes under', () => {
  it('resolves the lineage root for a session found outside the recents page', () => {
    $projectTree.set([tree([row('tip-4', 'Aged out and compacted', 'root-4')])])

    const { result } = renderHook(() => useSessionRowScalars('tip-4'))

    expect(result.current.pinId).toBe('root-4')
    expect(result.current.title).toBe('Aged out and compacted')
  })

  it('a colour picked under that key is the colour the dot then resolves', () => {
    const stored = row('tip-4', 'Aged out and compacted', 'root-4')
    $projectTree.set([tree([stored])])

    const { result } = renderHook(() => useSessionRowScalars('tip-4'))
    setSessionColorOverride(result.current.pinId, '#ff0000')

    expect(sessionColorFor(stored)).toBe('#ff0000')
  })

  it('falls back to the raw id, and no title, for an id no source knows', () => {
    const { result } = renderHook(() => useSessionRowScalars('unknown-1'))

    expect(result.current.pinId).toBe('unknown-1')
    expect(result.current.title).toBeNull()
  })
})
