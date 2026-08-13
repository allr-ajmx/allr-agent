import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getHermesConfigRecord = vi.fn()

// MemorySection renders the memory.provider field plus, when a provider is set,
// the inline OAuth Connect affordance and the collapsible provider-config panel.
vi.mock('@/hermes', () => ({
  // Via ConfigSection → store/projects → store/profile → store/profiles, which
  // syncs the REST scope at import time.
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: () => getHermesConfigRecord(),
  getHermesConfigSchema: vi.fn(async () => ({ fields: { 'memory.provider': { type: 'string' } } })),
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  getMemoryProviderOAuthStatus: vi.fn(async () => ({ auth: null, connected: false, detail: '', state: 'idle' })),
  startMemoryProviderOAuth: vi.fn(async () => ({ auth: null, connected: false, detail: '', state: 'pending' })),
  getMemoryProviderConfig: vi.fn(async () => ({
    name: 'mem0',
    label: 'Mem0',
    docs_url: '',
    fields: [
      {
        key: 'api_key',
        kind: 'secret',
        label: 'API Key',
        is_set: false,
        value: '',
        placeholder: 'sk-...',
        description: '',
        group: 'Connection',
        inline: true,
        options: []
      }
    ]
  })),
  saveMemoryProviderConfig: vi.fn(async () => ({ ok: true }))
}))

import { MemoryRouter } from 'react-router-dom'

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { MemorySection } from './memory-section'

// Router context: the config section underneath reads ?field= for palette
// deep links.
function renderMemory() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <MemorySection />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('MemorySection', () => {
  beforeEach(() => {
    queryClient.clear()
    // Reset, not just re-stub: the call COUNT is an assertion below, and this
    // mock is shared across the file.
    getHermesConfigRecord.mockReset()
    getHermesConfigRecord.mockResolvedValue({ memory: { provider: 'mem0' } })
  })

  afterEach(() => queryClient.clear())

  it('shows the Connect affordance and provider config panel for the set provider', async () => {
    renderMemory()

    // MemoryConnect surfaces once the OAuth-status probe resolves (capable).
    expect(await screen.findByText('Connect')).toBeInTheDocument()
    // ProviderConfigPanel renders the collapsible header for the provider.
    expect(await screen.findByText('Mem0 settings')).toBeInTheDocument()
  })

  it('reaches the failed-load state on the first attempt, not after a retry ladder', async () => {
    getHermesConfigRecord.mockRejectedValue(new Error('gateway down'))

    renderMemory()

    // This page renders against the app's SHARED query client, whose production
    // defaults retry three times at 1s/2s/4s: the skeleton holds for ~7s and
    // this assertion dies on Vitest's 5s testTimeout. `test-setup.ts` takes the
    // ladder off — without that, no test in this app can reach a failed-load
    // state at any timeout the suite would tolerate.
    expect(await screen.findByText('Settings failed to load')).toBeInTheDocument()
    expect(getHermesConfigRecord).toHaveBeenCalledTimes(1)
  })
})
