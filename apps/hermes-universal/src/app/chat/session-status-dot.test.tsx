/**
 * MJXHRM-385 — the ONE session status dot, and whether it tells the truth about
 * the session the caller actually named.
 *
 * The dot resolves everything itself from the shared live-status collections,
 * which are keyed by the slice's CURRENT stored session id. Auto-compression
 * ROTATES that id, and universal deliberately leaves the surfaces holding the
 * old one alone — a pane tile, a mobile bubble and a layout pane id all keep
 * the pre-rotation id and are aliased onto the live slice by the stored-id
 * index (MJX-133). So a dot that asks under one id alone goes dark on exactly
 * the surfaces this ticket unified: the tab and the bubble.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

const { $attentionSessionIds, $sessions, $unreadFinishedSessionIds } = await import('@/store/session')
const { $projects } = await import('@/store/projects')
const { $sessionColorOverrides } = await import('@/store/session-color')
const { $sessionStates } = await import('@/store/session-state-types')
const { SessionStatusDot } = await import('./session-status-dot')

/** The row shape the backend surfaces AFTER a compression: the row's own id is
 *  the live TIP, and `_lineage_root_id` names the conversation's first id — the
 *  one every persisted surface is still holding. */
const compressedRow = (tip: string, root: string): SessionInfo =>
  ({ id: tip, _lineage_root_id: root, title: 'Rotated' }) as unknown as SessionInfo

/** A slice whose turn is live, keyed (as the real thing is) by runtime id and
 *  carrying the POST-rotation stored id. */
const busySlice = (runtimeId: string, storedSessionId: string) => {
  $sessionStates.set({
    [runtimeId]: {
      awaitingResponse: false,
      branch: '',
      busy: true,
      cwd: '',
      fast: false,
      interimBoundaryPending: false,
      interrupted: false,
      lastTouchedAt: 0,
      liveTitle: '',
      messages: [],
      model: '',
      needsInput: false,
      pendingBranchGroup: null,
      personality: '',
      provider: '',
      reasoningEffort: '',
      runtimeSessionId: runtimeId,
      sawAssistantPayload: false,
      serviceTier: '',
      sessionStartedAt: null,
      statusLine: '',
      storedSessionId,
      streamId: null,
      turnStartedAt: null,
      usage: null,
      yolo: false
    }
  })
}

beforeEach(() => {
  $sessionStates.set({})
  $sessions.set([])
  $attentionSessionIds.get()
  $unreadFinishedSessionIds.set([])
  $projects.set([])
  $sessionColorOverrides.set({})
})

describe('SessionStatusDot — a session whose stored id rotated', () => {
  it('paints the running turn for a tab still holding the pre-rotation id', () => {
    $sessions.set([compressedRow('tip-2', 'root-1')])
    busySlice('runtime-9', 'tip-2')

    // What a tile / bubble opened before the compression passes: the ROOT id,
    // and the row the wider lookup resolves for it (whose own id is the tip).
    render(<SessionStatusDot session={compressedRow('tip-2', 'root-1')} storedSessionId="root-1" />)

    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('paints unread claimed under the OLD id for a row now on the new tip', () => {
    // The other direction: the turn settled before the rotation, so the unread
    // marker names the root while the sidebar row names the tip.
    $unreadFinishedSessionIds.set(['root-1'])

    render(<SessionStatusDot session={compressedRow('tip-2', 'root-1')} storedSessionId="tip-2" />)

    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('claims nothing for an unrelated session', () => {
    busySlice('runtime-9', 'tip-2')

    render(<SessionStatusDot session={compressedRow('other-tip', 'other-root')} storedSessionId="other-root" />)

    // Idle: no `role="status"` node at all, just the colour chip.
    expect(screen.queryByRole('status')).toBeNull()
  })
})

/**
 * MJXHRM-386 — the colour half. An IDLE dot paints the session's colour, and
 * `$sessionColorById` is built from the recents page alone, so the dot on a tab
 * for an older session has no map entry to read. `sessionColorFor` falling back
 * to the resolver is what keeps that dot coloured — and the resolver has to
 * reach the override under the DURABLE id, since the row a compacted session
 * resolves to carries a rotated `id`.
 */
describe('SessionStatusDot — colour for a session outside the recents page', () => {
  const idleChip = (container: HTMLElement) => container.querySelector('span[aria-hidden="true"]') as HTMLElement

  it('inherits the project colour with no entry in the shared map', () => {
    const older = { cwd: '/www/app', git_repo_root: '/www/app', id: 'old-1', title: 'Old' } as unknown as SessionInfo

    $sessions.set([])
    $projects.set([
      {
        archived: false,
        color: '#5865f2',
        folders: [{ added_at: 0, is_primary: true, label: null, path: '/www/app' }],
        id: 'p_app',
        name: 'app'
      } as never
    ])

    const { container } = render(<SessionStatusDot session={older} storedSessionId="old-1" />)

    expect(idleChip(container).style.backgroundColor).toBe('rgb(88, 101, 242)')
  })

  it('reads an override stored under the lineage root, not the rotated tip', () => {
    $sessionColorOverrides.set({ 'root-1': '#ff0000' })

    const { container } = render(
      <SessionStatusDot session={compressedRow('tip-1', 'root-1')} storedSessionId="root-1" />
    )

    expect(idleChip(container).style.backgroundColor).toBe('rgb(255, 0, 0)')
  })
})

describe('SessionStatusDot — draft', () => {
  it('paints the draft dot when the surface names no stored session', () => {
    const { container } = render(<SessionStatusDot storedSessionId={null} />)

    // Draft is the one active state with no `role="status"` — nothing is
    // happening, it is only "nothing has ever run here".
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('[title]')).toBeTruthy()
  })
})
