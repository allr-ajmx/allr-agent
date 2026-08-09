/**
 * Keep-awake on the Advanced page: a device-local machine preference with no
 * config key, so it rides above the schema fields rather than among them.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so it is erased and cannot trip vi.mock's hoisting.
import type * as PlatformModule from '@/lib/platform'

vi.mock('@/hermes', () => ({
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({})),
  getHermesConfigSchema: vi.fn(async () => ({ fields: {} })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

const { desktop } = vi.hoisted(() => ({ desktop: { value: true } }))

vi.mock('@/lib/platform', async importActual => ({
  ...(await importActual<typeof PlatformModule>()),
  get IS_DESKTOP() {
    return desktop.value
  }
}))

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $keepAwake } from '@/store/keep-awake'

import { SectionBody } from './settings-section'

const renderAdvanced = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <SectionBody section="advanced" />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )

beforeEach(() => {
  desktop.value = true
  $keepAwake.set(false)
  queryClient.clear()
})

afterEach(() => {
  $keepAwake.set(false)
  queryClient.clear()
})

describe('Advanced → keep computer awake', () => {
  it('flips the preference from the row', async () => {
    renderAdvanced()

    const toggle = await screen.findByRole('switch', { name: 'Keep computer awake' })
    expect(toggle).toBeInTheDocument()

    fireEvent.click(toggle)
    expect($keepAwake.get()).toBe(true)
  })

  it('is absent off desktop', async () => {
    desktop.value = false
    renderAdvanced()

    // The page still renders — wait for it before asserting the row is missing.
    await screen.findByText('Nothing to configure')
    expect(screen.queryByRole('switch', { name: 'Keep computer awake' })).not.toBeInTheDocument()
  })
})
