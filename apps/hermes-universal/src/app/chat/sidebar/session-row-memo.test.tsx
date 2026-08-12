/**
 * MJXHRM-45 — PROOF that `SidebarSessionRow`'s memo comparator cannot silently
 * drop a prop it was never told about.
 *
 * The comparator is a `memo()` equality function, so a prop it does not compare
 * is not merely "unoptimized" — the row KEEPS THE OLD VALUE in the DOM. The
 * concrete casualty was `data-index`, which `virtual-session-list.tsx` passes
 * and which TanStack Virtual reads back off the node inside `measureElement`
 * (`indexAttribute`, default `data-index`) to decide which row a ResizeObserver
 * measurement belongs to. `SidebarSessionRowProps extends ComponentProps<'div'>`,
 * so the old hand-written list of 12 named props compared none of it.
 *
 * WHAT IS BEING TESTED, precisely: a re-render in which the `session` object
 * keeps its identity — every named prop equal — while `data-index` moves. That
 * is exactly what a list reorder produces (drag-reordering pins, a search
 * narrowing, a session moving on activity), and it is the case the old
 * comparator answered "equal" to.
 *
 * It is NOT a test that the memo bails out. The memo still bails, and must —
 * the second assertion below re-renders with everything identical and proves the
 * row did not re-render, so this file cannot be "passed" by deleting the
 * boundary.
 */

import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import type * as SessionRowState from './session-row-state'

/**
 * Counts renders of the REAL `SidebarSessionRowImpl` (MJXHRM-383).
 *
 * `sessionShowsRunningArc` is a pure helper the impl calls exactly once per
 * render, so wrapping it counts renders without touching the thing under test:
 * the row component, its `memo()` and `rowPropsEqual` all stay real, and the
 * wrapper delegates to the original. Mocking the row itself would make the
 * memo untestable — the bail-out IS the behaviour.
 */
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

import { $pinnedSessionIds, $sidebarAgentsGrouped } from '@/store/layout'
import { $showAllProfiles } from '@/store/profile'
import { $projectScope, $projectTree, ALL_PROJECTS } from '@/store/projects'
import { $activeStoredSessionId, $searchLoading, $sessions } from '@/store/session'

import { SidebarSessionRow } from './session-row'
import { SidebarScrollBody } from './sidebar-content'

const session: SessionInfo = {
  ended_at: null,
  id: 'sess-1',
  input_tokens: 0,
  is_active: false,
  last_active: Math.floor(Date.now() / 1000),
  message_count: 2,
  model: null,
  output_tokens: 0,
  started_at: Math.floor(Date.now() / 1000),
  title: 'Row under test'
} as SessionInfo

const noop = () => {}

/** Renders one row; `data-index` is the virtualizer's identity attribute. */
function Row({ index }: { index: number }) {
  return (
    <SidebarSessionRow
      data-index={index}
      isPinned={false}
      isSelected={false}
      isWorking={false}
      onArchive={noop}
      onDelete={noop}
      onPin={noop}
      onResume={noop}
      // Same object identity across re-renders — a reorder does not mint a new
      // SessionInfo, it moves the existing one.
      session={session}
    />
  )
}

describe('SidebarSessionRow memo comparator', () => {
  it('re-renders when only data-index moves, so the virtualizer measures the right row', () => {
    const { container, rerender } = render(<Row index={3} />)

    expect(container.querySelector('[data-index]')?.getAttribute('data-index')).toBe('3')

    rerender(<Row index={4} />)

    expect(container.querySelector('[data-index]')?.getAttribute('data-index')).toBe('4')
  })

  it('is still a memo boundary with a custom comparator', () => {
    // Guards the cheap way to make the test above pass: deleting the boundary.
    // The row MUST stay memoized — it is the sidebar's hottest component — so
    // the fix is "compare every prop", never "compare none".
    const boundary = SidebarSessionRow as unknown as { $$typeof: symbol; compare: unknown }

    expect(boundary.$$typeof).toBe(Symbol.for('react.memo'))
    expect(typeof boundary.compare).toBe('function')
  })
})

/**
 * MJXHRM-383's actual definition of done: "verify `renderRow`'s memo actually
 * skips re-renders for unrelated updates". It could not, because the boundary
 * that decides this is the ROW's memo (nothing between `SidebarScrollBody` and
 * the row is memoized — every consumer CALLS `renderRow` during its own render),
 * and `rowPropsEqual` resolves the row down to `Object.is` on the `session`
 * object. These render the real sidebar and count the real component.
 */
function listRow(id: string, title: string, startedAt: number): SessionInfo {
  return {
    _lineage_root_id: null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: startedAt,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: startedAt,
    title,
    tool_call_count: 0
  } as SessionInfo
}

describe('sidebar rows under an unrelated store write', () => {
  afterEach(() => {
    $sessions.set([])
    $pinnedSessionIds.set([])
    $sidebarAgentsGrouped.set(false)
    $projectTree.set([])
    $projectScope.set(ALL_PROJECTS)
    $showAllProfiles.set(false)
    $activeStoredSessionId.set(null)
    $searchLoading.set(false)
    mockRowRenders.count = 0
  })

  const mountSidebar = async () => {
    $sessions.set([listRow('a', 'Alpha chat', 200), listRow('b', 'Beta chat', 100)])

    render(
      <MemoryRouter>
        <SidebarScrollBody />
      </MemoryRouter>
    )

    // Let the mount-time refresh effects settle (they fail against no gateway
    // and leave the seeded rows alone) so the baseline count is stable.
    await act(async () => {})
  }

  it('re-renders no row when a store the rows do not read is written', async () => {
    await mountSidebar()

    const baseline = mockRowRenders.count
    expect(baseline).toBeGreaterThan(0)

    // `$searchLoading` is read by SidebarScrollBody (it drives the search
    // field's spinner) and by nothing below it, so the parent re-renders and
    // rebuilds every row element — and every row must bail.
    await act(async () => void $searchLoading.set(true))

    expect(mockRowRenders.count).toBe(baseline)
  })

  it('repaints every row when the list is replaced wholesale', async () => {
    // Pins WHY `refreshSessions` has to share identities (lib/structural-share):
    // the comparator resolves the row down to `Object.is` on `session`, so a
    // JSON-parsed page stored verbatim repaints the whole sidebar even when it
    // is byte-identical. This is the failure the store-side gate prevents; if
    // this assertion ever flips, the comparator stopped reading `session`.
    await mountSidebar()

    const baseline = mockRowRenders.count

    await act(async () => void $sessions.set($sessions.get().map(session => ({ ...session }))))

    expect(mockRowRenders.count).toBeGreaterThan(baseline)
  })

  it('still re-renders the row whose own state moved', async () => {
    // The opposite failure, and the worse one: a memo that never re-renders is a
    // list that stops updating. Selecting a session must repaint its row.
    await mountSidebar()

    const baseline = mockRowRenders.count

    await act(async () => void $activeStoredSessionId.set('a'))

    expect(mockRowRenders.count).toBeGreaterThan(baseline)
  })
})
