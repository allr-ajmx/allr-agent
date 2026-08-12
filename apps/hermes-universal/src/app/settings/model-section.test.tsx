import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MoaConfigResponse } from '@/types/hermes'

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
const saveMoaModels = vi.fn()
let profileSwitchHandler: (() => void) | null = null

vi.mock('@/hermes', () => ({
  getAuxiliaryModels: () => getAuxiliaryModels(),
  getGlobalModelInfo: () => getGlobalModelInfo(),
  getGlobalModelOptions: () => getGlobalModelOptions(),
  getHermesConfigRecord: async () => ({ agent: { reasoning_effort: 'medium' } }),
  getMoaModels: () => getMoaModels(),
  getRecommendedDefaultModel: async () => ({ free_tier: null, model: '', provider: '' }),
  saveHermesConfig: async () => ({ ok: true }),
  saveMoaModels: (body: unknown) => saveMoaModels(body),
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
  saveMoaModels.mockResolvedValue({ ok: true })
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

describe('ModelSettings MoA preset editor', () => {
  const moaPreset = (): MoaConfigResponse['presets'][string] => ({
    aggregator: { model: 'anthropic/claude-opus-4.8', provider: 'openrouter' },
    aggregator_temperature: 0,
    degraded_reference_policy: 'loud' as const,
    enabled: true,
    max_tokens: 4096,
    reference_models: [
      { model: 'hermes-4', provider: 'nous' },
      { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' }
    ],
    reference_temperature: 0,
    reference_timeout: null
  })

  const moaConfig = (): MoaConfigResponse => ({
    ...moaPreset(),
    active_preset: '',
    default_preset: 'default',
    presets: { default: moaPreset() }
  })

  beforeEach(() => {
    getGlobalModelInfo.mockResolvedValue({ model: 'hermes-4', provider: 'nous' })
    getGlobalModelOptions.mockResolvedValue({
      providers: [
        { authenticated: true, models: ['hermes-4', 'hermes-4-mini'], name: 'Nous', slug: 'nous' },
        {
          authenticated: true,
          models: ['deepseek/deepseek-v4-pro', 'anthropic/claude-opus-4.8'],
          name: 'OpenRouter',
          slug: 'openrouter'
        }
      ]
    })
    getMoaModels.mockResolvedValue(moaConfig())
    saveMoaModels.mockImplementation((body: unknown) => Promise.resolve(body))
  })

  async function openReferenceEditor() {
    await renderModelSettings()
    expect(await screen.findByText('Reference 1')).toBeTruthy()
  }

  function slotSelects() {
    // Combobox order in the MoA section (last 7 on the page): preset select,
    // then provider+model per reference (2 refs), then aggregator
    // provider+model. Reference 1's pair is therefore at -6 / -5.
    const all = screen.getAllByRole('combobox')

    return { ref1Model: all.at(-5)!, ref1Provider: all.at(-6)! }
  }

  it('saves a disabled reference model without removing it (per-slot enabled toggle)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(screen.getByRole('switch', { name: 'Disable reference 1' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({
            default: expect.objectContaining({
              reference_models: [
                expect.objectContaining({ enabled: false, model: 'hermes-4', provider: 'nous' }),
                expect.objectContaining({ model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' })
              ]
            })
          })
        })
      )
      // The disabled row stays in the list — disabling is not deleting.
      expect(screen.getByText('nous · hermes-4')).toBeTruthy()
      expect(screen.getByRole('switch', { name: 'Enable reference 1' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('autosaves the selected preset when its enabled switch is toggled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledWith(
        expect.objectContaining({
          presets: expect.objectContaining({ default: expect.objectContaining({ enabled: false }) })
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds the autosave while a slot is half-filled (provider changed, model pending)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(slotSelects().ref1Provider)
      fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))

      // Model was cleared by the provider change → config incomplete → the
      // debounced autosave must NOT fire, even well past the 600ms window.
      // The backend answers a half-filled slot with 422, so sending it would
      // both fail and surface an error the user never caused.
      await vi.advanceTimersByTimeAsync(2000)
      expect(saveMoaModels).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves once the model pick completes the slot', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(slotSelects().ref1Provider)
      fireEvent.click(await screen.findByRole('option', { name: 'OpenRouter' }))
      await vi.advanceTimersByTimeAsync(700)

      fireEvent.click(slotSelects().ref1Model)
      fireEvent.click(await screen.findByRole('option', { name: 'anthropic/claude-opus-4.8' }))
      await vi.advanceTimersByTimeAsync(700)

      expect(saveMoaModels).toHaveBeenCalledTimes(1)
      const sent = saveMoaModels.mock.calls[0][0] as MoaConfigResponse

      expect(sent.presets.default.reference_models[0]).toEqual({
        model: 'anthropic/claude-opus-4.8',
        provider: 'openrouter'
      })
      // The untouched slots ride along unchanged — nothing reverts to defaults.
      expect(sent.presets.default.reference_models[1]).toEqual({
        model: 'deepseek/deepseek-v4-pro',
        provider: 'openrouter'
      })
      expect(sent.presets.default.aggregator).toEqual({
        model: 'anthropic/claude-opus-4.8',
        provider: 'openrouter'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not clear the model or save when the same provider is re-selected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      await openReferenceEditor()

      fireEvent.click(slotSelects().ref1Provider)
      fireEvent.click(await screen.findByRole('option', { name: 'Nous' }))
      await vi.advanceTimersByTimeAsync(700)

      // Radix treats re-picking the current value as a no-op (no
      // onValueChange), so nothing changes: no save, model still shown.
      expect(saveMoaModels).not.toHaveBeenCalled()
      expect(screen.getByText('nous · hermes-4')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries a disabled slot through an unrelated aggregator edit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    try {
      getMoaModels.mockResolvedValue({
        ...moaConfig(),
        presets: {
          default: {
            ...moaPreset(),
            reference_models: [
              { enabled: false, model: 'hermes-4', provider: 'nous' },
              { model: 'deepseek/deepseek-v4-pro', provider: 'openrouter' }
            ]
          }
        }
      })
      await openReferenceEditor()

      // Aggregator model is the last combobox on the page.
      const comboboxes = screen.getAllByRole('combobox')

      fireEvent.click(comboboxes.at(-1)!)
      fireEvent.click(await screen.findByRole('option', { name: 'deepseek/deepseek-v4-pro' }))
      await vi.advanceTimersByTimeAsync(700)

      const sent = saveMoaModels.mock.calls[0][0] as MoaConfigResponse

      expect(sent.presets.default.aggregator.model).toBe('deepseek/deepseek-v4-pro')
      // `enabled: false` must not be silently reset by an edit elsewhere.
      expect(sent.presets.default.reference_models[0].enabled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
