import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $connectionError } from '@/store/connection'

import { GatewayConnectingScreen } from './gateway-connecting-screen'

const renderScreen = () =>
  render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConnectingScreen />
      </QueryClientProvider>
    </I18nProvider>
  )

afterEach(() => $connectionError.set(null))

describe('GatewayConnectingScreen recovery', () => {
  it('offers the escape hatch without showing the configurator while dialling', () => {
    renderScreen()
    expect(screen.getByRole('button', { name: 'Use a different gateway' })).toBeInTheDocument()
    expect(screen.queryByText('Connection mode')).not.toBeInTheDocument()
  })

  // A failed dial is where re-homing matters: the connect surface comes to the user
  // instead of dropping them back to the picker.
  it('reveals the embedded configurator once the dial errors', () => {
    $connectionError.set('connection refused')
    renderScreen()
    expect(screen.getByText('connection refused')).toBeInTheDocument()
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
    // Giving up entirely stays reachable.
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument()
  })
})
