import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as WindowsModule from '@/store/windows'

// Same shim as use-statusbar-items.test.tsx: keep the health poller / getStatus off
// the network while the panel renders.
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

// The panel's platform seam: on Android this launches the native screen Activity,
// elsewhere it navigates in-app. Both are the same call from here. Partial — the rest
// of the module (isSecondaryWindow &c.) is read at import time across the store graph.
vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsModule>()),
  openAppRoute: vi.fn()
}))

import { openAppRoute } from '@/store/windows'

import { GatewayMenuPanel, type GatewaySwitchAffordance } from './gateway-menu-panel'

const renderPanel = (gatewaySwitch: GatewaySwitchAffordance, onClose = vi.fn()) => {
  render(
    <MemoryRouter>
      <GatewayMenuPanel
        gatewayState="open"
        gatewaySwitch={gatewaySwitch}
        inferenceStatus={null}
        onClose={onClose}
        onOpenSystem={vi.fn()}
        statusSnapshot={null}
      />
    </MemoryRouter>
  )

  return { onClose }
}

beforeEach(() => {
  vi.mocked(openAppRoute).mockClear()
})

describe('GatewayMenuPanel — gateway switch affordance', () => {
  // The phone never mounts the Statusbar, so this popover (in the right drawer's
  // Status list) is where "Change gateway" has to live — and the drawer is too
  // cramped for the connect form, so it hands off to Settings ▸ Gateway.
  it('leaves for Settings ▸ Gateway in `link` mode', () => {
    const { onClose } = renderPanel('link')

    fireEvent.click(screen.getByRole('button', { name: /change gateway/i }))

    expect(openAppRoute).toHaveBeenCalledWith('/settings/gateway')
    expect(onClose).toHaveBeenCalled()
    // No inline form — that's the whole point of this mode.
    expect(screen.queryByRole('button', { name: /hide gateway settings/i })).not.toBeInTheDocument()
  })

  it('expands the inline configurator in `embedded` mode', () => {
    renderPanel('embedded')

    fireEvent.click(screen.getByRole('button', { name: /change gateway/i }))

    expect(openAppRoute).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /hide gateway settings/i })).toBeInTheDocument()
  })

  it('offers nothing in `none` mode', () => {
    renderPanel('none')

    expect(screen.queryByRole('button', { name: /change gateway/i })).not.toBeInTheDocument()
  })
})
