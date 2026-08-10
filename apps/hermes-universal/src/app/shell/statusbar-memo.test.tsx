/**
 * MJXHRM-303 — PROOF that `StatusbarItemView`'s memo can hit.
 *
 * The ticket asks for the bippy render counter. That needs a dev build, which
 * this agent cannot run, and bippy is only verified to LOAD under WebKitGTK, not
 * to REPORT. So the claim is pinned here instead, which is strictly stronger as
 * a regression guard: it runs in CI on every push and fails loudly the day
 * someone reintroduces a fresh item literal.
 *
 * WHAT IS ACTUALLY BEING TESTED, precisely — because it is easy to test the
 * wrong thing here and come away reassured:
 *
 * `StatusbarItemView` is memoized on reference equality of `item`. So the memo
 * hits exactly when an item object KEEPS ITS IDENTITY across a re-render of the
 * hook. That is the property asserted below.
 *
 * It is NOT the same as "the bar does not re-render". `useStatusbarItems`
 * subscribes to ~20 stores, so the component hosting it still re-renders on any
 * of them — that is by design and unchanged by this ticket. What changes is that
 * its 13 children no longer re-render with it. Counting commits of the whole
 * subtree would therefore measure the parent and prove nothing, which is the
 * trap this file exists to avoid.
 */

import { render } from '@testing-library/react'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/system-status', async () => {
  const { atom } = await import('nanostores')

  return {
    $appVersion: atom<null | string>('1.2.3'),
    $gatewayRestarting: atom(false),
    $inferenceStatus: atom(null),
    $statusSnapshot: atom(null),
    runGatewayRestart: vi.fn()
  }
})

import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import { resetChat } from '@/store/chat'
import { $gatewayState } from '@/store/gateway'
import { $terminalOpen } from '@/store/layout'
import { $statusbarHiddenIds, STATUSBAR_HIDDEN_BY_DEFAULT } from '@/store/statusbar-prefs'

import { useStatusbarItems } from './hooks/use-statusbar-items'

/** Every render's returned items, so identities can be compared across them. */
let renders: { left: readonly StatusbarItem[]; right: readonly StatusbarItem[] }[] = []

function Probe() {
  const { leftStatusbarItems, statusbarItems } = useStatusbarItems()

  renders.push({ left: leftStatusbarItems, right: statusbarItems })

  return null
}

const renderProbe = () =>
  render(
    <MemoryRouter>
      <Probe />
    </MemoryRouter>
  )

const byId = (items: readonly StatusbarItem[]) => new Map(items.map(item => [item.id, item]))

beforeEach(() => {
  renders = []
  $statusbarHiddenIds.set([])
})

afterEach(() => {
  $gatewayState.set('idle')
  $terminalOpen.set(false)
  $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
  resetChat()
})

describe('useStatusbarItems identity (MJXHRM-303)', () => {
  it('keeps every unrelated item identical when one item’s own store moves', () => {
    renderProbe()

    const first = renders.at(-1)

    expect(first).toBeDefined()

    act(() => {
      $terminalOpen.set(true)
    })

    const next = renders.at(-1)

    // The hook DID re-run — otherwise the assertions below are vacuous.
    expect(renders.length).toBeGreaterThan(1)
    expect(next).not.toBe(first)

    const before = byId(first?.right ?? [])
    const after = byId(next?.right ?? [])

    // The item that actually changed.
    expect(after.get('terminal')).not.toBe(before.get('terminal'))

    // Everything else keeps its identity, so `memo` bails on all of them. Before
    // this ticket every one of these was a fresh literal and the memo could not
    // hit once.
    for (const [id, item] of before) {
      if (id !== 'terminal') {
        expect(after.get(id), `right item "${id}" lost its identity`).toBe(item)
      }
    }

    const leftBefore = byId(first?.left ?? [])
    const leftAfter = byId(next?.left ?? [])

    for (const [id, item] of leftBefore) {
      expect(leftAfter.get(id), `left item "${id}" lost its identity`).toBe(item)
    }
  })

  it('keeps the returned arrays identical across a re-render with no input change', () => {
    renderProbe()

    const first = renders.at(-1)

    act(() => {
      // A store the bar subscribes to, written with a value that changes nothing
      // any item reads. The arrays themselves must survive it.
      $gatewayState.set($gatewayState.get())
    })

    const next = renders.at(-1)

    expect(next?.left).toBe(first?.left)
    expect(next?.right).toBe(first?.right)
  })

  it('still rebuilds the item whose own data moved, so the bar cannot go stale', () => {
    renderProbe()

    const before = byId(renders.at(-1)?.right ?? []).get('terminal')

    expect(before?.title).toBe('Show terminal')

    act(() => {
      $terminalOpen.set(true)
    })

    // A memo that never re-renders is a worse bug than one that always does.
    expect(byId(renders.at(-1)?.right ?? []).get('terminal')?.title).toBe('Hide terminal')
  })
})
