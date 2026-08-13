/**
 * MJXHRM-391 — `renderProjectRows` is the ONE funnel every project/profile lane
 * row passes through, so it is where the filter menu narrows the tree.
 *
 * This file pins both halves of that, because they pull in opposite directions:
 *
 *  1. The filter must REACH the lanes. Lane sessions come from the backend's
 *     `projects.tree` snapshot, not from `$sessions`, so nothing upstream can
 *     pre-narrow them without rebuilding the tree objects (which would mint new
 *     `SessionInfo` references and break `SidebarSessionRow`'s memo wholesale).
 *  2. The filter must NOT destabilize the callback. `renderRow` /
 *     `renderProjectRows` are `useCallback`ed on purpose (MJXHRM-219): a fresh
 *     identity per render is a new prop for every lane, so one unrelated store
 *     write rebuilt the whole list mid-scroll. `sessionFilter` therefore has to
 *     be `undefined` — not a `() => true` — whenever nothing narrows.
 *
 * `SidebarProfileGroup` is stubbed with a faithful stand-in: the real component
 * calls `renderRows(group.sessions.slice(0, page))` during its own render and
 * this does the same, which is what lets the identity be observed at all.
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import type { SidebarSessionGroup } from './projects/model'

/** Every `renderRows` identity handed to a lane, in render order. */
const seenRenderRows: unknown[] = []

vi.mock('./profile-group', () => ({
  SidebarProfileGroup: ({
    group,
    renderRows
  }: {
    group: SidebarSessionGroup
    renderRows: (sessions: SessionInfo[]) => React.ReactNode
  }) => {
    seenRenderRows.push(renderRows)

    return <div data-testid="lane">{renderRows(group.sessions)}</div>
  }
}))

import { SidebarSessionsSection } from './sessions-section'

function row(id: string, title: string): SessionInfo {
  return {
    _lineage_root_id: null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: false,
    last_active: 100,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    source: null,
    started_at: 100,
    title,
    tool_call_count: 0
  } as SessionInfo
}

const groups: SidebarSessionGroup[] = [
  {
    color: null,
    id: 'default',
    label: 'default',
    path: null,
    sessions: [row('a', 'Alpha chat'), row('b', 'Beta chat')]
  }
]

const noop = () => {}
// Module-level, and load-bearing: `renderRow`'s dependency list names this set
// and the four handlers. In the app they arrive from `rowHandlers`, a `useMemo`
// in `sidebar-content`. Minting either per render here would make the identity
// churn for a reason that has nothing to do with what is under test — which is
// what the first draft of this file did, and the assertion caught it.
const NO_WORKING = new Set<string>()

function Section({ label, sessionFilter }: { label: string; sessionFilter?: (s: SessionInfo) => boolean }) {
  return (
    <SidebarSessionsSection
      activeSessionId={null}
      emptyState={null}
      groups={groups}
      label={label}
      onArchiveSession={noop}
      onDeleteSession={noop}
      onResumeSession={noop}
      onToggle={noop}
      onTogglePin={noop}
      open
      pinned={false}
      sessionFilter={sessionFilter}
      sessions={[]}
      workingSessionIdSet={NO_WORKING}
    />
  )
}

describe('renderProjectRows and the lane filter', () => {
  it('narrows lane rows through the funnel', () => {
    // The fixture DISAGREES with the expected outcome: both rows render first,
    // so a filter that reaches nothing would fail the second assertion.
    const { getByTestId, rerender } = render(<Section label="Sessions" />)

    expect(getByTestId('lane').textContent).toContain('Alpha chat')
    expect(getByTestId('lane').textContent).toContain('Beta chat')

    rerender(<Section label="Sessions" sessionFilter={session => session.id === 'b'} />)

    expect(getByTestId('lane').textContent).not.toContain('Alpha chat')
    expect(getByTestId('lane').textContent).toContain('Beta chat')
  })

  it('keeps ONE callback identity across an unrelated re-render when nothing narrows', () => {
    seenRenderRows.length = 0

    const { rerender } = render(<Section label="Sessions" />)

    // A prop the row pipeline does not depend on. The section re-renders; the
    // lane callback must not be rebuilt.
    rerender(<Section label="Recents" />)

    expect(seenRenderRows.length).toBe(2)
    expect(seenRenderRows[0]).toBe(seenRenderRows[1])
  })

  it('rebuilds the callback when — and only when — the filter itself changes', () => {
    seenRenderRows.length = 0

    const filter = (session: SessionInfo) => session.id === 'b'
    const { rerender } = render(<Section label="Sessions" />)

    rerender(<Section label="Sessions" sessionFilter={filter} />)
    // Same filter identity: nothing changed, so nothing may be rebuilt.
    rerender(<Section label="Sessions" sessionFilter={filter} />)

    expect(seenRenderRows.length).toBe(3)
    expect(seenRenderRows[1]).not.toBe(seenRenderRows[0])
    expect(seenRenderRows[2]).toBe(seenRenderRows[1])
  })
})
