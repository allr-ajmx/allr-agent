import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix Select calls scrollIntoView on its items when the content opens; jsdom
// doesn't implement it (nor hasPointerCapture / releasePointerCapture).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelInfo = vi.fn()
const getGlobalModelOptions = vi.fn()
const getAuxiliaryModels = vi.fn()
const getMoaModels = vi.fn()
let profileSwitchHandler: (() => void) | null = null

vi.mock('@/hermes', () => ({
  getAuxiliaryModels: () => getAuxiliaryModels(),
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getGlobalModelOptions: () => getGlobalModelOptions(),
  getHermesConfigRecord: async () => ({ agent: { reasoning_effort: 'medium' } }),
  getMoaModels: () => getMoaModels(),
  getRecommendedDefaultModel: async () => ({ free_tier: null, model: '', provider: '' }),
  saveHermesConfig: async () => ({ ok: true }),
  saveMoaModels: async () => ({ ok: true }),
  setApiRequestProfile: () => {},
  setEnvVar: async () => ({ ok: true }),
  setModelAssignment: async () => ({ gateway_tools: [], model: '', provider: '' })
}))

vi.mock('@/store/onboarding', () => ({
  beginProviderConnect: () => {},
  openOnboarding: () => {},
  resolveProviderSetup: () => null
}))

// Captured rather than driven through the store so the assertion is about what
// ModelSettings does on a switch, not about how the profile atom notifies.
vi.mock('@/app/hooks/use-on-profile-switch', () => ({
  useOnProfileSwitch: (handler: () => void) => {
    profileSwitchHandler = handler
  }
}))

const providerFixture = (name: string, slug: string, model: string) => ({
  providers: [{ authenticated: true, models: [model], name, slug }]
})

beforeEach(() => {
  getAuxiliaryModels.mockResolvedValue({ main: { model: '', provider: '' }, tasks: [] })
  getMoaModels.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  profileSwitchHandler = null
})

async function renderModelSettings() {
  const { ModelSettings } = await import('./model-section')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ModelSettings />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('ModelSettings', () => {
  // The panel stays mounted across a profile switch. Left un-reloaded it keeps
  // profile A's provider/model selection, and Apply then writes A's model into
  // B — the `prev || …` seeding never overwrites a non-empty selection.
  it('replaces the selected provider and model when the active profile changes', async () => {
    getGlobalModelInfo
      .mockResolvedValueOnce({ model: 'local-a', provider: 'custom' })
      .mockResolvedValueOnce({ model: 'hermes-4', provider: 'nous' })
    getGlobalModelOptions
      .mockResolvedValueOnce(providerFixture('Custom A', 'custom', 'local-a'))
      .mockResolvedValueOnce(providerFixture('Nous', 'nous', 'hermes-4'))

    await renderModelSettings()
    expect((await screen.findAllByRole('combobox'))[0].textContent).toContain('Custom A')

    await act(async () => {
      profileSwitchHandler?.()
    })

    await waitFor(() => expect(getGlobalModelInfo).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByRole('combobox')[0].textContent).toContain('Nous'))
  })
})
