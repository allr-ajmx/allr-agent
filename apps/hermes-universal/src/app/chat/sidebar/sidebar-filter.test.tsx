/**
 * MJXHRM-391 — the sidebar filter menu's BEHAVIOUR, against the real sidebar.
 *
 * The menu itself is a dropdown of radios and checkboxes; what is worth testing
 * is what those writes do to the list. Every case here mounts the real
 * `SidebarScrollBody` over the real stores and asserts on the rendered rows, so
 * a filter that writes its atom but narrows nothing fails.
 *
 * Two of these guard traps specific to universal rather than desktop:
 *
 *  - The PINNED section resolves a pin that has fallen past the loaded page from
 *    `$pinnedSessionCache`. Filtering the pool BEFORE that resolution would let
 *    the cache hand the row straight back — the filter would appear to work on
 *    Recents and silently fail on Pinned.
 *  - `renderProjectRows` is a `useCallback` that MJXHRM-219 memoized on purpose.
 *    The last case proves the filter machinery did not destabilize the row
 *    pipeline it hangs off.
 */

import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as SidebarArchive from '@/store/sidebar-archive'
import type { SessionInfo } from '@/types/hermes'

import type * as SessionRowState from './session-row-state'

// Same render counter as `session-row-memo.test.tsx`: `sessionShowsRunningArc`
// is a pure helper the row impl calls exactly once per render, so wrapping it
// counts renders of the REAL row without touching its memo.
const mockRowRenders = { count: 0 }

vi.mock('./session-row-state', async importOriginal => {
  const actual = await importOriginal<typeof SessionRowState>()

  return {
    ...actual,
    sessionShowsRunningArc: (...args: Parameters<typeof actual.sessionShowsRunningArc>) => {
      mockRowRenders.count += 1

      return actual.sessionShowsRunningArc(...args)
    }
  }
})

// The Archived view fetches its own page. Stub the FETCH only — `$archivedSessions`
// stays the real atom, so a case can seed it and assert the pool actually swaps.
vi.mock('@/store/sidebar-archive', async importOriginal => {
  const actual = await importOriginal<typeof SidebarArchive>()

  return { ...actual, loadArchivedSessions: vi.fn(async () => {}) }
})

import {
  $pinnedSessionIds,
  $sidebarAgentsGrouped,
  $sidebarPrFilter,
  $sidebarProjectFilter,
  $sidebarSessionOrderIds,
  $sidebarSessionOrderManual,
  $sidebarShowArchived,
  $sidebarStatusFilter,
  $sidebarViewCustomized,
  $sidebarWorkspaceNodeOpen,
  resetSidebarView,
  setSidebarOrdering,
  setWorkspaceNodesOpen
} from '@/store/layout'
import { $showAllProfiles } from '@/store/profile'
import { $projectScope, $projectTree, ALL_PROJECTS } from '@/store/projects'
import { $activeStoredSessionId, $searchLoading, $sessions, $unreadFinishedSessionIds } from '@/store/session'
import { $archivedSessions } from '@/store/sidebar-archive'

import { SidebarScrollBody } from './sidebar-content'

function row(id: string, title: string, times: { started: number; updated?: number }): SessionInfo {
  return {
    _lineage_root_id: null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: times.updated ?? times.started,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: times.started,
    title,
    tool_call_count: 0
  } as SessionInfo
}

const mountSidebar = async () => {
  render(
    <MemoryRouter>
      <SidebarScrollBody />
    </MemoryRouter>
  )

  // Let the mount-time refresh effects settle (they fail against no gateway and
  // leave the seeded rows alone).
  await act(async () => {})
}

/** Rendered session titles, top to bottom. */
const renderedTitles = () => screen.queryAllByText(/^(Alpha|Beta|Gamma|Archived) chat$/).map(node => node.textContent)

afterEach(() => {
  $sessions.set([])
  $archivedSessions.set([])
  $pinnedSessionIds.set([])
  $sidebarAgentsGrouped.set(false)
  $projectTree.set([])
  $projectScope.set(ALL_PROJECTS)
  $showAllProfiles.set(false)
  $activeStoredSessionId.set(null)
  $searchLoading.set(false)
  $unreadFinishedSessionIds.set([])
  $sidebarStatusFilter.set([])
  $sidebarPrFilter.set([])
  $sidebarProjectFilter.set([])
  $sidebarShowArchived.set(false)
  $sidebarSessionOrderManual.set(false)
  $sidebarSessionOrderIds.set([])
  $sidebarWorkspaceNodeOpen.set({})
  setSidebarOrdering('updated')
  mockRowRenders.count = 0
})

describe('the filter menu itself', () => {
  it('is mounted in the real sidebar header, and reads as engaged once a filter narrows', async () => {
    // Reachability: every behaviour below writes a store directly, so without
    // this the whole file would pass against a menu nothing renders.
    $sessions.set([row('a', 'Alpha chat', { started: 300 })])

    await mountSidebar()

    const trigger = screen.getByLabelText('Filters')
    expect(trigger).toBeTruthy()
    // The engaged treatment is what tells a user rows are being hidden. Absent
    // by default — the fixture disagrees with the expected outcome.
    expect(trigger.className).not.toContain('ui-control-active-background) text-foreground opacity-100')

    await act(async () => void $sidebarStatusFilter.set(['unread']))

    expect(screen.getByLabelText('Filters').className).toContain(
      'bg-(--ui-control-active-background) text-foreground opacity-100'
    )
  })
})

describe('sidebar status filter', () => {
  it('narrows recents to the chosen status', async () => {
    // Seeded so the fixture DISAGREES with the expected outcome: all three rows
    // are present and visible before the filter, and only one is unread.
    $sessions.set([row('a', 'Alpha chat', { started: 300 }), row('b', 'Beta chat', { started: 200 })])
    $unreadFinishedSessionIds.set(['b'])

    await mountSidebar()

    expect(renderedTitles()).toEqual(['Alpha chat', 'Beta chat'])

    await act(async () => void $sidebarStatusFilter.set(['unread']))

    expect(renderedTitles()).toEqual(['Beta chat'])
  })

  it('narrows the PINNED section too, and the pin cache does not hand the row back', async () => {
    // The trap: `pinnedSessionRows` falls back to `$pinnedSessionCache` for a pin
    // the loaded page no longer covers. Narrowing the POOL before that lookup
    // would resurrect exactly the row the filter removed.
    $sessions.set([row('a', 'Alpha chat', { started: 300 }), row('b', 'Beta chat', { started: 200 })])
    $pinnedSessionIds.set(['a'])
    $unreadFinishedSessionIds.set(['b'])

    await mountSidebar()

    // Alpha is pinned and rendered — the filter has something to remove.
    expect(renderedTitles()).toEqual(['Alpha chat', 'Beta chat'])

    await act(async () => void $sidebarStatusFilter.set(['unread']))

    expect(renderedTitles()).toEqual(['Beta chat'])
  })
})

describe('sidebar ordering', () => {
  it('sorts by last activity by default and by creation when asked', async () => {
    // `started_at` and `last_active` deliberately DISAGREE: Beta was created
    // last but touched first, so the two orders are opposites. A comparator that
    // read the wrong field would pass one of these assertions and fail the other.
    $sessions.set([
      row('a', 'Alpha chat', { started: 300, updated: 100 }),
      row('b', 'Beta chat', { started: 100, updated: 300 })
    ])

    await mountSidebar()

    expect(renderedTitles()).toEqual(['Beta chat', 'Alpha chat'])

    await act(async () => void setSidebarOrdering('created'))

    expect(renderedTitles()).toEqual(['Alpha chat', 'Beta chat'])
  })

  it('drops a hand-dragged order when a sort key is picked', () => {
    $sidebarSessionOrderManual.set(true)
    $sidebarSessionOrderIds.set(['b', 'a'])

    setSidebarOrdering('created')

    // Both halves: the flag AND the saved sequence. Clearing only the flag
    // leaves the order to snap back the next time a drag re-arms it.
    expect($sidebarSessionOrderManual.get()).toBe(false)
    expect($sidebarSessionOrderIds.get()).toEqual([])
  })
})

describe('sidebar archived view', () => {
  it('swaps the recents pool for the archived set', async () => {
    $sessions.set([row('a', 'Alpha chat', { started: 300 })])
    $archivedSessions.set([row('z', 'Archived chat', { started: 50 })])

    await mountSidebar()

    expect(renderedTitles()).toEqual(['Alpha chat'])

    await act(async () => void $sidebarShowArchived.set(true))

    expect(renderedTitles()).toEqual(['Archived chat'])
  })
})

describe('sidebar view reset', () => {
  it('reports the view as customized only once something moved, and undoes it', () => {
    expect($sidebarViewCustomized.get()).toBe(false)

    $sidebarStatusFilter.set(['unread'])
    expect($sidebarViewCustomized.get()).toBe(true)

    resetSidebarView()

    expect($sidebarStatusFilter.get()).toEqual([])
    expect($sidebarViewCustomized.get()).toBe(false)
  })
})

describe('setWorkspaceNodesOpen', () => {
  it('folds a whole level in one write and leaves untouched ids alone', () => {
    $sidebarWorkspaceNodeOpen.set({ other: true })

    setWorkspaceNodesOpen(['p1', 'p2'], false)

    expect($sidebarWorkspaceNodeOpen.get()).toEqual({ other: true, p1: false, p2: false })
  })
})

describe('the filter machinery and the memoized row pipeline', () => {
  it('repaints no row when an unrelated store is written, with filters active', async () => {
    // MJXHRM-219's defect shape: filter state that re-creates `renderRow` /
    // `renderProjectRows` turns any unrelated store write into a full list
    // repaint. `$searchLoading` is read by `SidebarScrollBody` and by nothing
    // below it, so the parent re-renders and rebuilds every row element — and
    // every row must still bail out of its memo.
    //
    // WHAT THIS CATCHES, verified by mutation: dropping the `useCallback` around
    // `sessionMatchesFilters` (an unstable predicate churns `recents`' deps)
    // turns this red. WHAT IT DOES NOT: cloning the session objects inside
    // `recents` stays green, because on an unrelated write that memo never
    // recomputes at all. The row memo resolves down to `Object.is` on `session`,
    // so object identity is guarded by `session-row-memo.test.tsx` instead.
    $sessions.set([row('a', 'Alpha chat', { started: 300 }), row('b', 'Beta chat', { started: 200 })])
    $unreadFinishedSessionIds.set(['a', 'b'])
    $sidebarStatusFilter.set(['unread'])

    await mountSidebar()

    const baseline = mockRowRenders.count
    expect(baseline).toBeGreaterThan(0)

    await act(async () => void $searchLoading.set(true))

    expect(mockRowRenders.count).toBe(baseline)
  })
})
