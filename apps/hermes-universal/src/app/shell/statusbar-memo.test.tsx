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

import type * as StatusbarControls from '@/app/shell/statusbar-controls'

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

/** Every `item` prop handed to a real `StatusbarItemView`, in render order. The
 *  memo compares that prop by reference, so recording it is the only way to see
 *  whether the memo can bail — the component itself renders nothing observable
 *  when it does. */
const painted = vi.hoisted(() => ({ items: [] as { id: string }[] }))

vi.mock('@/app/shell/statusbar-controls', async importOriginal => {
  const mod = await importOriginal<typeof StatusbarControls>()

  return {
    ...mod,
    StatusbarItemView: ({ item }: { item: { id: string } }) => {
      painted.items.push(item)

      return null
    }
  }
})

import { useStatusbarContributions } from '@/app/contrib/surfaces'
import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import { registry } from '@/contrib/registry'
import { resetChat } from '@/store/chat'
import { $gatewayState } from '@/store/gateway'
import { $terminalOpen } from '@/store/layout'
import { $statusbarHiddenIds, STATUSBAR_HIDDEN_BY_DEFAULT } from '@/store/statusbar-prefs'
import { $subagentsBySession } from '@/store/subagents'

import { useStatusbarItems } from './hooks/use-statusbar-items'
import { MobileStatusList } from './mobile-status-list'

/** Every render's returned items, so identities can be compared across them. */
let renders: { left: readonly StatusbarItem[]; right: readonly StatusbarItem[] }[] = []

function Probe() {
  const { leftStatusbarItems, statusbarItems } = useStatusbarItems()

  renders.push({ left: leftStatusbarItems, right: statusbarItems })

  return null
}

/** The shape the two REAL callers use: core items concatenated with the
 *  `statusBar.*` contribution areas. `Probe` passes no `opts` at all, which is a
 *  configuration nothing in the app ever renders. */
function ContribProbe() {
  const extraLeftItems = useStatusbarContributions('left')
  const extraRightItems = useStatusbarContributions('right')
  const { leftStatusbarItems, statusbarItems } = useStatusbarItems({ extraLeftItems, extraRightItems })

  renders.push({ left: leftStatusbarItems, right: statusbarItems })

  return null
}

const renderProbe = (node: React.ReactNode = <Probe />) => render(<MemoryRouter>{node}</MemoryRouter>)

const byId = (items: readonly StatusbarItem[]) => new Map(items.map(item => [item.id, item]))

/** A store write that changes the atom's IDENTITY without changing anything any
 *  item reads — `$subagentsBySession` re-mints its whole map on every subagent
 *  progress event, so this is the churn the bar really sees. It must re-render
 *  the hook (otherwise the identity assertions below are vacuous) while leaving
 *  every item's own inputs untouched. */
const unrelatedChurn = () => $subagentsBySession.set({})

beforeEach(() => {
  renders = []
  painted.items = []
  $statusbarHiddenIds.set([])
})

afterEach(() => {
  $gatewayState.set('idle')
  $terminalOpen.set(false)
  $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
  $subagentsBySession.set({})
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
    const rendersBefore = renders.length

    act(unrelatedChurn)

    const next = renders.at(-1)

    // The hook DID re-run. The previous version of this test wrote a store its
    // CURRENT value; nanostores' `set` early-returns on `oldValue === newValue`,
    // so nothing re-rendered and the two assertions below compared `renders.at(-1)`
    // with itself. It passed and proved nothing — the exact trap the header warns
    // about, committed by the test meant to avoid it.
    expect(renders.length).toBeGreaterThan(rendersBefore)
    expect(next?.left).toBe(first?.left)
    expect(next?.right).toBe(first?.right)
  })

  // The bar and the mobile Status list both concatenate the `statusBar.*`
  // contribution areas onto the core groups, so the no-`opts` `Probe` above
  // exercises a configuration the app never renders. `useStatusbarContributions`
  // mapped its (stable) registry snapshot into a fresh array on every render,
  // which re-minted both returned arrays unconditionally — with zero plugins
  // installed as much as with one.
  it('keeps the returned arrays identical when the contribution areas are wired in', () => {
    const dispose = registry.register({
      area: 'statusBar.left',
      data: { detail: '3', id: 'demo:queue', label: 'Queue', variant: 'text' },
      id: 'demo:queue',
      source: 'plugin:demo'
    })

    renderProbe(<ContribProbe />)

    const first = renders.at(-1)
    const rendersBefore = renders.length

    act(unrelatedChurn)

    const next = renders.at(-1)

    expect(renders.length).toBeGreaterThan(rendersBefore)
    expect(next?.left).toBe(first?.left)
    expect(next?.right).toBe(first?.right)
    // …and the contributed item keeps its identity too, so its own memo bails.
    expect(byId(next?.left ?? []).get('demo:queue')).toBe(byId(first?.left ?? []).get('demo:queue'))

    dispose()
  })

  // The phone never mounts `<Statusbar/>` (MobileController gates it on
  // !IS_MOBILE), so `MobileStatusList` is the ONLY surface these items reach on
  // mobile — and it reshapes every descriptor into a row before painting it. A
  // fresh object there discards the whole restructure above at the last hop.
  it('hands MobileStatusList rows a stable item identity across unrelated churn', () => {
    renderProbe(<MobileStatusList />)

    expect(painted.items.length).toBeGreaterThan(0)

    const before = new Map(painted.items.map(item => [item.id, item]))

    painted.items = []

    act(unrelatedChurn)

    // It DID repaint — otherwise the identity assertions are vacuous.
    expect(painted.items.length).toBeGreaterThan(0)

    for (const item of painted.items) {
      expect(item, `row "${item.id}" lost its identity`).toBe(before.get(item.id))
    }
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
