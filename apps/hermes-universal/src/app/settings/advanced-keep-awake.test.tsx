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

// Rust answers with the inhibitor it actually holds, so the row has to follow
// that answer rather than the ask — mocked here at the same IPC boundary the
// store test uses.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, args: { on: boolean }) => args.on) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

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
  invoke.mockReset()
  invoke.mockImplementation(async (_cmd: string, args: { on: boolean }) => args.on)
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

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('set_keep_awake', { on: true }))
    expect(toggle).toBeChecked()
  })

  // There is no logind under WSL or on a non-systemd distro: the ask really is
  // refused in the wild, and a switch left sitting "on" over a machine free to
  // sleep is the one outcome this row must never produce.
  it('snaps back off when the OS refuses the inhibitor', async () => {
    invoke.mockRejectedValueOnce(new Error('no logind'))
    renderAdvanced()

    const toggle = await screen.findByRole('switch', { name: 'Keep computer awake' })

    fireEvent.click(toggle)
    await vi.waitFor(() => expect(toggle).not.toBeChecked())
    expect($keepAwake.get()).toBe(false)
  })

  it('is absent off desktop', async () => {
    desktop.value = false
    renderAdvanced()

    // The page still renders — wait for it before asserting the row is missing.
    await screen.findByText('Nothing to configure')
    expect(screen.queryByRole('switch', { name: 'Keep computer awake' })).not.toBeInTheDocument()
  })
})
