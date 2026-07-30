import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { $busy, $turnStartedAt, resetChat } from '@/store/chat'
import { $gatewayState } from '@/store/gateway'

import { Statusbar } from './statusbar'

const renderStatusbar = () =>
  render(
    <MemoryRouter>
      <Statusbar />
    </MemoryRouter>
  )

afterEach(() => {
  $gatewayState.set('idle')
  resetChat()
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
    $busy.set(true)
    $turnStartedAt.set(Date.now())
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
