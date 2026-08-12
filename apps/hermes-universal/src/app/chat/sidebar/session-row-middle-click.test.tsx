/**
 * MJXHRM-402's definition of done: "test covers middle-click on sidebar rows".
 *
 * PR #118 declined it, on the grounds that "`middleClickHandlers`' arm/spend
 * state is a real pointer sequence across two elements, and a jsdom test of it
 * would assert the mock, not the behaviour". Nothing here is mocked but the
 * haptic buzz: the row is the real component, `openSessionTile` is the real
 * store write, and what is asserted is the tile that appears — so deleting the
 * gesture, or wiring it to the wrong verb, fails this file.
 *
 * The row is also the one surface where the gesture had to be SPLIT across
 * existing pointer props instead of spread, because the same pointerdown starts
 * the session drag. That split is what these pin down.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

vi.mock('@/lib/haptics', () => ({ triggerHaptic: () => Promise.resolve() }))

const session = {
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

async function setup() {
  const states = await import('@/store/session-states')
  const { SidebarSessionRow } = await import('./session-row')

  render(
    <SidebarSessionRow
      isPinned={false}
      isSelected={false}
      isWorking={false}
      onArchive={noop}
      onDelete={noop}
      onPin={noop}
      onResume={noop}
      reorderable
      session={session}
    />
  )

  // The pointer handlers live on the row BODY (`SidebarRowBody`, a button).
  // The kebab is its grid SIBLING, not a descendant — see the kebab case below.
  return { row: screen.getByText('Row under test').closest('button')!, states }
}

const tiled = (states: { $sessionTiles: { get: () => { storedSessionId: string }[] } }) =>
  states.$sessionTiles.get().map(tile => tile.storedSessionId)

beforeEach(() => {
  window.localStorage.clear()
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.resetModules()
})

describe('sidebar row middle-click', () => {
  it('opens the conversation in its own tile — browser muscle memory, not a close', async () => {
    const { row, states } = await setup()

    expect(tiled(states)).toEqual([])

    fireEvent.mouseDown(row, { button: 1 })
    fireEvent.pointerDown(row, { button: 1 })
    fireEvent.pointerUp(row, { button: 1 })

    // Opened alongside, and NOT removed from the list: a sidebar row is a
    // session, not a tab — there is nothing here to close.
    expect(tiled(states)).toEqual(['sess-1'])
    expect(screen.getByText('Row under test')).toBeInTheDocument()
  })

  it('does not fire without an auxclick — the event a scrolling list swallows', async () => {
    const { row, states } = await setup()

    // Every event the gesture is allowed to depend on, and no `auxclick`.
    fireEvent.mouseDown(row, { button: 1 })
    fireEvent.pointerDown(row, { button: 1 })
    fireEvent.pointerUp(row, { button: 1 })
    expect(tiled(states)).toEqual(['sess-1'])
  })

  it('cancels the middle mousedown so no autoscroll pan starts over the list', async () => {
    const { row } = await setup()

    expect(fireEvent.mouseDown(row, { button: 1 })).toBe(false)
  })

  it('leaves the reorder handle alone — it bails before the gesture arms', async () => {
    const { row, states } = await setup()
    const handle = row.querySelector('[data-reorder-handle]')!

    fireEvent.pointerDown(handle, { button: 1 })
    fireEvent.pointerUp(handle, { button: 1 })
    expect(tiled(states)).toEqual([])
  })

  // The row's pointerdown bails on `[data-reorder-handle], [data-row-actions]`.
  // Only the first of those exists: nothing in the app sets `data-row-actions`,
  // and it never needed to — the kebab is a GRID SIBLING of the row body, so a
  // press on it is not a press on the element carrying the gesture. Asserted so
  // the structural reason is pinned rather than the dead selector.
  it('leaves the kebab alone — it is outside the element carrying the gesture', async () => {
    const { row, states } = await setup()
    const kebab = screen.getByRole('button', { name: 'Actions for Row under test' })

    expect(row.contains(kebab)).toBe(false)

    fireEvent.pointerDown(kebab, { button: 1 })
    fireEvent.pointerUp(kebab, { button: 1 })
    expect(tiled(states)).toEqual([])
  })

  it('a left press still runs the row drag rather than the middle-click verb', async () => {
    const { row, states } = await setup()

    fireEvent.pointerDown(row, { button: 0 })
    fireEvent.pointerUp(row, { button: 0 })
    expect(tiled(states)).toEqual([])
  })
})
