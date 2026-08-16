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
// The clipboard goes through the OS seam, not `navigator.clipboard` — on
// WebKitGTK the web API is refused in cases Chromium allows, and this command IS
// the sign-in flow (MJXHRM-415). Asserting on the seam is also what makes the
// assertion synchronous: the real seam only reaches the web API after a dynamic
// import has failed, two microtasks later than the click.
vi.mock('@/lib/clipboard', () => ({ writeClipboardText: vi.fn(async () => {}) }))

import { listOAuthProviders } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard'
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
  vi.mocked(writeClipboardText).mockClear()
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

    expect(writeClipboardText).toHaveBeenCalledWith('hermes auth add qwen-oauth')
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

// Fireworks is the promoted BYOK provider — it leads the key catalog and carries
// the badge that used to sit on OpenRouter.
describe('OnboardingScreen — the promoted key provider', () => {
  const keyRows = () =>
    screen
      .getAllByRole('button')
      .map(button => button.textContent ?? '')
      .filter(text => text.includes('Fireworks AI') || text.includes('OpenRouter'))

  it('puts Fireworks ahead of OpenRouter', async () => {
    renderScreen()
    await screen.findByRole('button', { name: /Sign in with Qwen/ })

    const [first, second] = keyRows()
    expect(first).toContain('Fireworks AI')
    expect(second).toContain('OpenRouter')
  })

  it('badges Fireworks with its pitch, and leaves OpenRouter unbadged', async () => {
    renderScreen()
    await screen.findByRole('button', { name: /Sign in with Qwen/ })

    const [fireworks, openrouter] = keyRows()
    expect(fireworks).toContain('Recommended')
    expect(fireworks).toContain('Direct model API — Fireworks-hosted frontier models')
    expect(openrouter).not.toContain('Recommended')
  })

  it('opens the key form on the Fireworks env var', async () => {
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: /Fireworks AI/ }))

    expect(screen.getByPlaceholderText(/Paste/)).toBeInTheDocument()
    expect($onboarding.get().option?.envKey).toBe('FIREWORKS_API_KEY')
  })
})

// `GET /api/model/recommended-default` returns 200 with an EMPTY model when it
// cannot resolve one, and `confirmModel()` assigns nothing in that case — so the
// confirm card must not name a model the user is not actually getting.
describe('OnboardingScreen — the confirm step with no resolved model', () => {
  const showConfirm = (recommended: null | { provider: string; model: string; free_tier: null }) =>
    $onboarding.set({
      step: 'confirm',
      option: null,
      providerSlug: 'fireworks',
      recommended,
      oauth: null,
      busy: false,
      error: null
    })

  it('says no default could be picked instead of showing a placeholder', () => {
    showConfirm(null)
    renderScreen()

    expect(screen.getByText(/could not pick a default model/)).toBeInTheDocument()
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument()
  })

  it('treats the endpoint’s empty-model answer the same way', () => {
    showConfirm({ provider: 'fireworks', model: '', free_tier: null })
    renderScreen()

    expect(screen.getByText(/could not pick a default model/)).toBeInTheDocument()
    // The provider line belongs to the model card; with no model there is none.
    expect(screen.queryByText('fireworks')).not.toBeInTheDocument()
  })

  it('shows the model card once one resolves', () => {
    showConfirm({ provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2', free_tier: null })
    renderScreen()

    expect(screen.getByText('accounts/fireworks/models/kimi-k2')).toBeInTheDocument()
    expect(screen.queryByText(/could not pick a default model/)).not.toBeInTheDocument()
  })
})
