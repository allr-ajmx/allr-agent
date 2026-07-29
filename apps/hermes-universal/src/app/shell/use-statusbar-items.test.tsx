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

import { resetChat } from '@/store/chat'
import { $gatewayState } from '@/store/gateway'
import { seedActiveSession } from '@/test-sessions'

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
    seedActiveSession('sess-1', { busy: true, turnStartedAt: Date.now() })
    renderStatusbar()

    expect(screen.getByText('Running')).toBeInTheDocument()
  })
})
