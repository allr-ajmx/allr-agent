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
    // Both literals matter: the settings grid is 4-col where Local is offered
    // and 3-col where it is not, so only rejecting one would prove nothing.
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-3')
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-4')
  })

  it('settings keeps the multi-column grid it has the width for', () => {
    const { container } = renderVariant('settings')
    const grid = container.querySelector('.auto-rows-fr')
    // Which literal depends on LOCAL_MODE_SUPPORTED; either proves settings did
    // not get swept up in the narrow-host single-column rule.
    expect(grid?.className).toMatch(/min-\[42rem\]:grid-cols-[34]/)
  })

  // The first-run local install flow belongs to the wizard alone. Settings and
  // the embedded recovery card are for a user who already HAS a working install
  // and wants to point back at it — replacing their connect button with a
  // detect-and-install screen would put a repo picker in front of someone who
  // only wanted to switch gateways.
  it.each(['embedded', 'settings'] as const)('%s keeps the plain local action bar', variant => {
    renderVariant(variant)
    expect(screen.queryByText('No local installation found')).not.toBeInTheDocument()
    expect(screen.queryByText('Looking for a local installation…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
  })

  // `onboarding` splits the grid and the panels into two wizard steps (see
  // app/connect-screen.tsx). These two must NOT: they are one-page surfaces, and
  // a leak would hide either the mode cards or the fields behind a step the host
  // has no control over.
  it.each(['embedded', 'settings'] as const)('%s shows the mode grid and the panel together', variant => {
    renderVariant(variant)
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
    // The wizard's step header belongs to onboarding alone.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
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
