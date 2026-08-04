import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Same shim as use-statusbar-items.test.tsx: keep the health poller / getStatus
// off the network while the list renders.
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

import { $pluginRecords } from '@/contrib/plugins-store'
import { registry } from '@/contrib/registry'
import { resetChat } from '@/store/chat'

import { MobileStatusList } from './mobile-status-list'

const renderList = () =>
  render(
    <MemoryRouter>
      <MobileStatusList />
    </MemoryRouter>
  )

afterEach(() => {
  resetChat()
  $pluginRecords.set({})
})

describe('MobileStatusList', () => {
  it('groups the core inventory into its named sections', () => {
    renderList()

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    // The Plugins section always exists: it leads with the manage row (the phone's
    // only route to Settings ▸ Plugins), heading + row label both reading "Plugins".
    expect(screen.getAllByText('Plugins')).toHaveLength(2)
  })

  // Before this, an id claimed by no SECTION was dropped on the floor — which is
  // every plugin contribution, since SECTIONS lists only core ids.
  it('surfaces an unclaimed contribution in the Plugins section, after the manage row', () => {
    const dispose = registry.register({
      area: 'statusBar.left',
      data: { detail: '3', id: 'demo:queue', label: 'Queue', variant: 'text' },
      id: 'demo:queue',
      source: 'plugin:demo'
    })

    renderList()

    expect(screen.getByText('Queue')).toBeInTheDocument()

    // The manage row leads the section, whichever bar group the contribution
    // arrived in.
    const labels = screen.getAllByText(/^(Plugins|Queue)$/).map(el => el.textContent)
    expect(labels.at(-2)).toBe('Plugins')
    expect(labels.at(-1)).toBe('Queue')

    dispose()
  })

  it('shows the plugin inventory counts, flagging failures', () => {
    $pluginRecords.set({
      broken: { id: 'broken', kind: 'disk', name: 'broken', status: 'error' },
      kanban: { id: 'kanban', kind: 'disk', name: 'kanban', status: 'loaded' },
      off: { id: 'off', kind: 'disk', name: 'off', status: 'disabled' }
    })

    renderList()

    // Loaded count, plus the failure — a disabled plugin is neither.
    expect(screen.getByText('1 · 1 failed')).toBeInTheDocument()
  })

  it('passes a render contribution through untouched — no row rewriting', () => {
    const dispose = registry.register({
      area: 'statusBar.right',
      id: 'demo:chip',
      render: () => <output data-testid="chip">live</output>,
      source: 'plugin:demo'
    })

    renderList()

    expect(screen.getByTestId('chip').textContent).toBe('live')

    dispose()
  })
})
