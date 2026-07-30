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
})

describe('MobileStatusList', () => {
  it('groups the core inventory into its named sections', () => {
    renderList()

    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('System')).toBeInTheDocument()
    // No contributions registered → no Plugins heading.
    expect(screen.queryByText('Plugins')).not.toBeInTheDocument()
  })

  // Before this, an id claimed by no SECTION was dropped on the floor — which is
  // every plugin contribution, since SECTIONS lists only core ids.
  it('surfaces an unclaimed contribution in a trailing Plugins section', () => {
    const dispose = registry.register({
      area: 'statusBar.left',
      data: { detail: '3', id: 'demo:queue', label: 'Queue', variant: 'text' },
      id: 'demo:queue',
      source: 'plugin:demo'
    })

    renderList()

    expect(screen.getByText('Plugins')).toBeInTheDocument()
    expect(screen.getByText('Queue')).toBeInTheDocument()

    dispose()
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
