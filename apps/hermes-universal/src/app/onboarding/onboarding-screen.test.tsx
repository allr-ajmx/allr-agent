import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OAuthProvider } from '@/types/hermes'

const qwen: OAuthProvider = {
  id: 'qwen-oauth',
  name: 'Qwen',
  cli_command: 'hermes auth add qwen-oauth',
  docs_url: 'https://github.com/QwenLM/qwen-code',
  flow: 'external',
  status: { logged_in: false }
}

const connected: OAuthProvider = { ...qwen, id: 'copilot', name: 'Copilot', status: { logged_in: true } }

vi.mock('@/hermes', () => ({
  cancelOAuthSession: vi.fn(async () => ({ ok: true })),
  getGlobalModelOptions: vi.fn(async () => ({ options: [] })),
  getRecommendedDefaultModel: vi.fn(async () => ({ provider: 'qwen-oauth', model: 'qwen3', free_tier: null })),
  listOAuthProviders: vi.fn(async () => ({ providers: [qwen, connected] })),
  setGlobalModel: vi.fn(async () => ({ ok: true })),
  startOAuthLogin: vi.fn(),
  updateEnvVars: vi.fn(async () => ({ ok: true }))
}))
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn(async () => ({})) }))

import { listOAuthProviders } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { $onboarding } from '@/store/onboarding'

import { OnboardingScreen } from './onboarding-screen'

const resetOnboarding = () =>
  $onboarding.set({
    step: 'picker',
    option: null,
    providerSlug: null,
    recommended: null,
    oauth: null,
    busy: false,
    error: null
  })

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <OnboardingScreen />
      </I18nProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  resetOnboarding()
  vi.mocked(listOAuthProviders).mockResolvedValue({ providers: [qwen, connected] })
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
})
afterEach(resetOnboarding)

describe('OnboardingScreen — CLI-terminal (external) providers', () => {
  it('offers an external provider in the picker and hides connected ones', async () => {
    renderScreen()

    expect(await screen.findByRole('button', { name: /Sign in with Qwen/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sign in with Copilot/ })).not.toBeInTheDocument()
  })

  it('lands on the CLI panel with the copyable command instead of a paste-code field', async () => {
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: /Sign in with Qwen/ }))

    expect(screen.getByText('hermes auth add qwen-oauth')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Paste authorization code/)).not.toBeInTheDocument()
    // No auth URL exists for this flow, so there is nothing to reopen.
    expect(screen.queryByRole('button', { name: /Reopen/ })).not.toBeInTheDocument()
  })

  it('copies the command to the clipboard', async () => {
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: /Sign in with Qwen/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hermes auth add qwen-oauth')
  })

  it('advances to the confirm step once the recheck finds the CLI creds', async () => {
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: /Sign in with Qwen/ }))
    vi.mocked(listOAuthProviders).mockResolvedValue({ providers: [{ ...qwen, status: { logged_in: true } }] })
    fireEvent.click(screen.getByRole('button', { name: "I've signed in" }))

    expect(await screen.findByText('qwen3')).toBeInTheDocument()
  })

  it('surfaces the "run it in a terminal first" hint when the recheck comes up empty', async () => {
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: /Sign in with Qwen/ }))
    fireEvent.click(screen.getByRole('button', { name: "I've signed in" }))

    await waitFor(() =>
      expect(screen.getByText(/Run `hermes auth add qwen-oauth` in a terminal first/)).toBeInTheDocument()
    )
  })
})
