import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $connection, $connectionPhase } from '@/store/connection'

import { GatewayConfigurator } from './gateway-configurator'

function renderVariant(variant: 'embedded' | 'onboarding' | 'settings') {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConfigurator variant={variant} />
      </QueryClientProvider>
    </I18nProvider>
  )
}

describe('GatewayConfigurator variants', () => {
  it('settings shows the page chrome: header + save-for-restart', () => {
    renderVariant('settings')
    expect(screen.getByText('Gateway Connection')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save for next restart' })).toBeInTheDocument()
  })

  // The embedded variant is hosted inside a popover / recovery card that owns its
  // own header and offers a single commit action.
  it('embedded drops the header and save-for-restart, keeps the connect surface', () => {
    renderVariant('embedded')
    expect(screen.queryByText('Gateway Connection')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save for next restart' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
  })

  it('embedded keeps the mode cards single-column at every window width', () => {
    const { container } = renderVariant('embedded')
    const grid = container.querySelector('.auto-rows-fr')
    // Both literals matter: the non-embedded grid is 4-col where Local is offered
    // and 3-col where it is not, so only rejecting one would prove nothing.
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-3')
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-4')
  })
})

// The session belongs to ONE gateway. Reporting it against whatever URL is in the field
// is how "sign in to a different gateway" became unreachable from Settings: the pill said
// Signed in, and the button it replaced was the only way to start the sign-in.
describe('signed-in state is scoped to the connected gateway', () => {
  afterEach(() => {
    $connection.set(null)
    $connectionPhase.set('idle')
    localStorage.clear()
  })

  function connectedTo(liveUrl: string, fieldUrl: string) {
    localStorage.setItem('hermes.url', fieldUrl)
    $connection.set({ baseUrl: liveUrl, mode: 'remote', authMode: 'oauth' })
    $connectionPhase.set('ready')
    renderVariant('settings')
  }

  it('shows Signed in for the gateway actually connected', () => {
    connectedTo('https://gw.a', 'https://gw.a')
    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('offers Sign in once the field holds a different gateway', () => {
    connectedTo('https://gw.a', 'https://gw.b')
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
