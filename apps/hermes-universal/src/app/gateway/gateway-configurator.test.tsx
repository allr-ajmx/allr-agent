import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

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
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-3')
  })
})
