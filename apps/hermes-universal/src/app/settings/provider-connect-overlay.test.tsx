import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OAuthProvider } from '@/types/hermes'

vi.mock('@/hermes', () => ({
  cancelOAuthSession: vi.fn(async () => ({ ok: true })),
  listOAuthProviders: vi.fn(async () => ({ providers: [] })),
  getRecommendedDefaultModel: vi.fn(async () => ({ provider: 'qwen-oauth', model: 'qwen', free_tier: null }))
}))
vi.mock('@/store/gateway', () => ({
  addGatewayEventListener: () => () => {},
  requestGateway: vi.fn(async () => ({}))
}))

import { I18nProvider } from '@/i18n'
import { $connectProvider, $onboarding } from '@/store/onboarding'

import { ProviderConnectOverlay } from './provider-connect-overlay'

const provider: OAuthProvider = {
  id: 'nous',
  name: 'Nous',
  cli_command: '',
  docs_url: '',
  flow: 'device_code',
  status: { logged_in: false }
}

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

function renderOverlay() {
  return render(
    <I18nProvider>
      <ProviderConnectOverlay />
    </I18nProvider>
  )
}

describe('ProviderConnectOverlay', () => {
  beforeEach(() => {
    resetOnboarding()
    $connectProvider.set(null)
  })
  afterEach(() => {
    resetOnboarding()
    $connectProvider.set(null)
  })

  it('renders nothing when no provider is connecting', () => {
    renderOverlay()
    expect(screen.queryByText(/Sign in with/)).not.toBeInTheDocument()
  })

  it('renders the device-code OTP + waiting state', () => {
    $connectProvider.set(provider)
    $onboarding.set({
      step: 'oauth',
      option: null,
      providerSlug: null,
      recommended: null,
      busy: false,
      error: null,
      oauth: { provider, sessionId: 's1', flow: 'device_code', url: 'https://x', userCode: 'WXYZ', status: 'pending' }
    })

    renderOverlay()
    expect(screen.getByText('WXYZ')).toBeInTheDocument()
    expect(screen.getByText(/Waiting for you to authorize/)).toBeInTheDocument()
  })

  it('renders the PKCE paste-code field', () => {
    $connectProvider.set(provider)
    $onboarding.set({
      step: 'oauth',
      option: null,
      providerSlug: null,
      recommended: null,
      busy: false,
      error: null,
      oauth: {
        provider: { ...provider, flow: 'pkce' },
        sessionId: 's2',
        flow: 'pkce',
        url: 'https://x',
        status: 'awaiting_code'
      }
    })

    renderOverlay()
    expect(screen.getByPlaceholderText(/Paste authorization code/)).toBeInTheDocument()
  })

  it('renders the confirm-model card with a Begin button', () => {
    $connectProvider.set(provider)
    $onboarding.set({
      step: 'confirm',
      option: null,
      providerSlug: 'nous',
      recommended: { provider: 'nous', model: 'Hermes-4', free_tier: true },
      busy: false,
      error: null,
      oauth: null
    })

    renderOverlay()
    expect(screen.getByText('Hermes-4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Begin' })).toBeInTheDocument()
  })

  it('renders the CLI-command panel for an external provider', () => {
    const qwen: OAuthProvider = {
      id: 'qwen-oauth',
      name: 'Qwen',
      cli_command: 'hermes auth add qwen-oauth',
      docs_url: 'https://github.com/QwenLM/qwen-code',
      flow: 'external',
      status: { logged_in: false }
    }

    $connectProvider.set(qwen)
    $onboarding.set({
      step: 'oauth',
      option: null,
      providerSlug: null,
      recommended: null,
      busy: false,
      error: null,
      oauth: { provider: qwen, sessionId: '', flow: 'external', url: '', status: 'external_pending' }
    })

    renderOverlay()
    // The command to run + the "I've signed in" recheck, not a browser flow.
    expect(screen.getByText('hermes auth add qwen-oauth')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "I've signed in" })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Paste authorization code/)).not.toBeInTheDocument()
  })

  it('closing the overlay clears the connecting provider', () => {
    $connectProvider.set(provider)
    $onboarding.set({
      step: 'oauth',
      option: null,
      providerSlug: null,
      recommended: null,
      busy: false,
      error: null,
      oauth: { provider, sessionId: 's3', flow: 'device_code', url: 'https://x', userCode: 'AAAA', status: 'pending' }
    })

    renderOverlay()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect($connectProvider.get()).toBeNull()
  })
})
