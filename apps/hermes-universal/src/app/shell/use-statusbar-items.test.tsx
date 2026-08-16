import { render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the system-status store so rendering the bar never starts the health
// poller / getVersion / getStatus (network) — we drive $appVersion directly.
vi.mock('@/store/system-status', async () => {
  const { atom } = await import('nanostores')

  return {
    $appVersion: atom<string | null>('1.2.3'),
    $gatewayRestarting: atom(false),
    $inferenceStatus: atom(null),
    $statusSnapshot: atom(null),
    runGatewayRestart: vi.fn()
  }
})

import { registry } from '@/contrib/registry'
import { resetChat } from '@/store/chat'
import { $gatewayState } from '@/store/gateway'
import { $statusbarHiddenIds, STATUSBAR_HIDDEN_BY_DEFAULT } from '@/store/statusbar-prefs'
import { $statusSnapshot } from '@/store/system-status'
import { $workspaceCwd } from '@/store/workspace-events'
import { seedActiveSession } from '@/test-sessions'

import { useStatusbarItems } from './hooks/use-statusbar-items'
import { Statusbar } from './statusbar'

const renderStatusbar = () =>
  render(
    <MemoryRouter>
      <Statusbar />
    </MemoryRouter>
  )

// These assert what the bar ASSEMBLES; the show/hide policy (several items ship
// switched off — see statusbar-visibility.test.tsx) is a separate concern, so
// turn everything on here.
beforeEach(() => {
  $statusbarHiddenIds.set([])
})

afterEach(() => {
  $gatewayState.set('idle')
  $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
  $statusSnapshot.set(null)
  $workspaceCwd.set('')
  resetChat()
})

// MJXHRM-394. The bar's cwd surfaces (the mobile list's value, the segment's own
// tooltip, and the tooltip on each workspace menu entry) are the widest path
// strings in the chrome, and `/home/<user>/` is the part of them that carries no
// information. Asserted on the ASSEMBLED items rather than the rendered bar
// because every one of these is a Radix tooltip that only mounts on hover.
describe('workspace cwd is tildified against the GATEWAY’s home', () => {
  const workspaceItem = (cwd: string, hermesHome: null | string) => {
    $workspaceCwd.set(cwd)
    $statusSnapshot.set(hermesHome === null ? null : ({ hermes_home: hermesHome } as never))

    const { result } = renderHook(() => useStatusbarItems({ includeAll: true, rich: true }), {
      wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>
    })

    const item = result.current.leftStatusbarItems.find(entry => entry.id === 'workspace-cwd')

    if (!item) {
      throw new Error('the bar assembled no workspace-cwd item')
    }

    return item
  }

  it('collapses the gateway user’s home in the detail, the tooltip and every menu entry', () => {
    const item = workspaceItem('/home/deploy/www/hermes-agent', '/home/deploy/.hermes')

    expect(item.detail).toBe('~/www/hermes-agent')
    expect(item.title).toBe('~/www/hermes-agent')
    expect(item.menuItems?.map(entry => entry.title)).toEqual([
      '~/www/hermes-agent',
      '~/www/hermes-agent',
      '~/www/hermes-agent'
    ])
  })

  it('leaves a path under a DIFFERENT user’s home fully spelled out', () => {
    const item = workspaceItem('/home/alice/www/hermes-agent', '/home/deploy/.hermes')

    expect(item.detail).toBe('/home/alice/www/hermes-agent')
    expect(item.title).toBe('/home/alice/www/hermes-agent')
  })

  it('leaves a path outside any home alone', () => {
    expect(workspaceItem('/srv/checkouts/app', '/home/deploy/.hermes').title).toBe('/srv/checkouts/app')
  })

  it('keeps the compact bar label a leaf, not a path', () => {
    expect(workspaceItem('/home/deploy/www/hermes-agent', '/home/deploy/.hermes').label).toBe('hermes-agent')
  })
})

describe('useStatusbarItems (rendered via <Statusbar/>)', () => {
  it('renders the core left items (gateway / agents / cron)', () => {
    renderStatusbar()

    expect(screen.getByText('Gateway')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Cron')).toBeInTheDocument()
  })

  it('shows the client version label from $appVersion', () => {
    renderStatusbar()

    expect(screen.getByText('client v1.2.3')).toBeInTheDocument()
  })

  it('hides the approval item until the gateway socket is open', () => {
    renderStatusbar()
    expect(screen.queryByText('Smart')).not.toBeInTheDocument()
  })

  it('shows the approval item (default Smart) once the gateway is open', () => {
    $gatewayState.set('open')
    renderStatusbar()

    expect(screen.getByText('Smart')).toBeInTheDocument()
  })

  it('reveals the running timer while a turn is in flight', () => {
    seedActiveSession('sess-1', { busy: true, turnStartedAt: Date.now() })
    renderStatusbar()

    expect(screen.getByText('Running')).toBeInTheDocument()
  })
})

// Group order is the contract plugins rely on: contributions sit at the OUTER end
// of the left group and the INNER end of the right group, so they never separate
// the app's own right-hand cluster (terminal / versions) from the window edge.
describe('statusBar.* contributions', () => {
  // The footer paints exactly two group divs: left, then right.
  const groupText = (container: HTMLElement, side: 'left' | 'right'): string => {
    const groups = container.querySelectorAll('[data-slot="statusbar"] > div')

    return groups[side === 'left' ? 0 : 1]?.textContent ?? ''
  }

  it('appends a left contribution after the core left items', () => {
    const dispose = registry.register({
      area: 'statusBar.left',
      data: { id: 'demo:left', label: 'LeftChip', variant: 'text' },
      id: 'demo:left',
      source: 'plugin:demo'
    })

    const { container } = renderStatusbar()
    const left = groupText(container, 'left')

    expect(left).toContain('LeftChip')
    expect(left.indexOf('Gateway')).toBeLessThan(left.indexOf('LeftChip'))

    dispose()
  })

  it('prepends a right contribution before the core right items', () => {
    const dispose = registry.register({
      area: 'statusBar.right',
      data: { id: 'demo:right', label: 'RightChip', variant: 'text' },
      id: 'demo:right',
      source: 'plugin:demo'
    })

    const { container } = renderStatusbar()
    const right = groupText(container, 'right')

    expect(right).toContain('RightChip')
    expect(right.indexOf('RightChip')).toBeLessThan(right.indexOf('client v1.2.3'))

    dispose()
  })

  it('wraps a render contribution in a blast wall instead of trusting it', () => {
    const dispose = registry.register({
      area: 'statusBar.left',
      id: 'demo:boom',
      render: () => {
        throw new Error('plugin exploded')
      },
      source: 'plugin:demo'
    })

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The core items still paint — a throwing contribution can't take the bar down.
    renderStatusbar()
    expect(screen.getByText('Gateway')).toBeInTheDocument()

    spy.mockRestore()
    dispose()
  })
})
