import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: vi.fn(),
  getRecommendedDefaultModel: vi.fn(async () => ({
    provider: 'openrouter',
    model: 'openrouter/auto',
    free_tier: null
  })),
  setEnvVar: vi.fn(async () => ({ ok: true })),
  setModelAssignment: vi.fn(async () => ({
    ok: true,
    provider: 'openrouter',
    model: 'openrouter/auto',
    scope: 'main'
  })),
  validateProviderCredential: vi.fn(async () => ({ ok: true, reachable: true, message: '', models: ['local/model'] })),
  listOAuthProviders: vi.fn(async () => ({ providers: [] })),
  startOAuthLogin: vi.fn(),
  pollOAuthSession: vi.fn(async () => ({ session_id: 's', status: 'pending' })),
  submitOAuthCode: vi.fn(async () => ({ ok: true, status: 'approved' })),
  cancelOAuthSession: vi.fn(async () => ({ ok: true }))
}))

// openExternalLink is fired during OAuth start; stub it (no Tauri host in tests).
vi.mock('@/lib/external-link', () => ({ openExternalLink: vi.fn(async () => {}) }))

import { API_KEY_OPTIONS } from '@/app/onboarding/api-key-options'
import {
  getGlobalModelOptions,
  getRecommendedDefaultModel,
  listOAuthProviders,
  setEnvVar,
  setModelAssignment,
  startOAuthLogin,
  validateProviderCredential
} from '@/hermes'
import type { OAuthProvider } from '@/types/hermes'

import {
  $onboarding,
  $onboardingActive,
  $onboardingSeen,
  backToPicker,
  checkConfigured,
  confirmModel,
  isCustomEndpointSlug,
  resolveProviderSetup,
  saveApiKey,
  startProviderOAuth,
  submitOnboardingCode
} from './onboarding'

const oauthProvider = (flow: 'device_code' | 'pkce'): OAuthProvider =>
  ({
    id: 'anthropic',
    name: 'Anthropic',
    flow,
    cli_command: '',
    docs_url: '',
    status: { logged_in: false }
  }) as OAuthProvider

const startLogin = vi.mocked(startOAuthLogin)

const options = vi.mocked(getGlobalModelOptions)
const setEnv = vi.mocked(setEnvVar)
const assign = vi.mocked(setModelAssignment)
const validate = vi.mocked(validateProviderCredential)

const recommend = vi.mocked(getRecommendedDefaultModel)

const openrouter = API_KEY_OPTIONS.find(o => o.id === 'openrouter')!
const local = API_KEY_OPTIONS.find(o => o.id === 'local')!
const fireworks = API_KEY_OPTIONS.find(o => o.id === 'fireworks')!
const openai = API_KEY_OPTIONS.find(o => o.id === 'openai')!

describe('onboarding store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    $onboardingSeen.set(false)
    $onboardingActive.set(false)
    $onboarding.set({
      step: 'picker',
      option: null,
      providerSlug: null,
      recommended: null,
      oauth: null,
      busy: false,
      error: null
    })
  })
  afterEach(() => localStorage.clear())

  it('marks seen (no wizard) when a provider is already configured', async () => {
    options.mockResolvedValueOnce({
      providers: [{ name: 'OpenRouter', slug: 'openrouter', authenticated: true, models: ['a'] }]
    } as never)
    await checkConfigured()
    expect($onboardingActive.get()).toBe(false)
    expect($onboardingSeen.get()).toBe(true)
  })

  it('activates the wizard when nothing is configured', async () => {
    options.mockResolvedValueOnce({
      providers: [{ name: 'OpenAI', slug: 'openai', authenticated: false, models: [] }]
    } as never)
    await checkConfigured()
    expect($onboardingActive.get()).toBe(true)
  })

  it('saves an API key then advances to the confirm step', async () => {
    const ok = await saveApiKey(openrouter, 'sk-test')
    expect(ok).toBe(true)
    expect(setEnv).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'sk-test')
    expect($onboarding.get().step).toBe('confirm')
    expect($onboarding.get().providerSlug).toBe('openrouter')
  })

  it('confirms the recommended model and finishes', async () => {
    await saveApiKey(openrouter, 'sk-test')
    const ok = await confirmModel()
    expect(ok).toBe(true)
    expect(assign).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'main', provider: 'openrouter', model: 'openrouter/auto' })
    )
    expect($onboardingSeen.get()).toBe(true)
    expect($onboardingActive.get()).toBe(false)
  })

  // `GET /api/model/recommended-default` answers 200 with `model: ""` when it
  // cannot resolve one — it never errors — so the empty string is the shape the
  // client actually has to survive.
  it('falls back to the provider catalog when recommended-default answers with an empty model', async () => {
    recommend.mockResolvedValueOnce({ provider: 'fireworks', model: '', free_tier: null })
    options.mockResolvedValueOnce({
      providers: [{ name: 'Fireworks AI', slug: 'fireworks', models: ['accounts/fireworks/models/kimi-k2'] }]
    } as never)

    await saveApiKey(fireworks, 'fw-test')

    expect($onboarding.get().recommended).toEqual({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/kimi-k2',
      free_tier: null
    })
  })

  it('recommends nothing — and assigns nothing — when no model can be resolved at all', async () => {
    recommend.mockResolvedValueOnce({ provider: 'fireworks', model: '', free_tier: null })
    options.mockResolvedValueOnce({ providers: [] } as never)

    await saveApiKey(fireworks, 'fw-test')
    expect($onboarding.get().recommended).toBeNull()

    await confirmModel()
    expect(assign).not.toHaveBeenCalled()
  })

  it('looks the OpenAI option up under the slug the backend actually uses', async () => {
    recommend.mockResolvedValueOnce({ provider: 'openai-api', model: 'gpt-5', free_tier: null })

    await saveApiKey(openai, 'sk-test')

    expect(recommend).toHaveBeenCalledWith('openai-api')
    expect($onboarding.get().providerSlug).toBe('openai-api')
  })

  it('wires a local endpoint via validate + custom assignment', async () => {
    const ok = await saveApiKey(local, 'http://127.0.0.1:8000/v1', 'endpoint-key')
    expect(ok).toBe(true)
    expect(validate).toHaveBeenCalledWith('OPENAI_BASE_URL', 'http://127.0.0.1:8000/v1', 'endpoint-key')
    expect(assign).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'custom', base_url: 'http://127.0.0.1:8000/v1', model: 'local/model' })
    )
    expect($onboardingSeen.get()).toBe(true)
  })

  it('enters the OAuth step for a device_code provider', async () => {
    startLogin.mockResolvedValueOnce({
      flow: 'device_code',
      session_id: 'sess',
      verification_url: 'https://v',
      user_code: 'ABCD',
      expires_in: 600,
      poll_interval: 5
    } as never)
    await startProviderOAuth(oauthProvider('device_code'))
    const oauth = $onboarding.get().oauth
    expect($onboarding.get().step).toBe('oauth')
    expect(oauth?.flow).toBe('device_code')
    expect(oauth?.userCode).toBe('ABCD')
    backToPicker() // stop the poll timer
  })

  it('completes a PKCE flow: submit code → confirm step', async () => {
    startLogin.mockResolvedValueOnce({
      flow: 'pkce',
      session_id: 'sess',
      auth_url: 'https://a',
      expires_in: 600
    } as never)
    await startProviderOAuth(oauthProvider('pkce'))
    expect($onboarding.get().oauth?.flow).toBe('pkce')

    const ok = await submitOnboardingCode('the-code')
    expect(ok).toBe(true)
    expect($onboarding.get().step).toBe('confirm')
    expect($onboarding.get().providerSlug).toBe('anthropic')
  })
})

describe('resolveProviderSetup', () => {
  const listProviders = vi.mocked(listOAuthProviders)

  beforeEach(() => {
    vi.clearAllMocks()
    listProviders.mockResolvedValue({ providers: [oauthProvider('pkce')] } as never)
  })

  it.each(['custom', 'local', 'CUSTOM', ' Custom ', 'custom:my-box'])(
    'treats %s as a custom endpoint without consulting the OAuth catalog',
    async slug => {
      await expect(resolveProviderSetup(slug)).resolves.toEqual({ kind: 'custom-endpoint' })
      expect(listProviders).not.toHaveBeenCalled()
    }
  )

  it('resolves a known provider slug to its OAuth connect target', async () => {
    const target = await resolveProviderSetup('Anthropic')
    expect(target.kind).toBe('oauth')
    expect(target.kind === 'oauth' && target.provider.id).toBe('anthropic')
  })

  it('falls back to the picker for an unknown slug', async () => {
    await expect(resolveProviderSetup('does-not-exist')).resolves.toEqual({ kind: 'picker' })
  })

  it('falls back to the picker for an empty slug, with no catalog call', async () => {
    await expect(resolveProviderSetup('   ')).resolves.toEqual({ kind: 'picker' })
    expect(listProviders).not.toHaveBeenCalled()
  })

  it('falls back to the picker when the OAuth catalog call fails', async () => {
    listProviders.mockRejectedValueOnce(new Error('gateway down'))
    await expect(resolveProviderSetup('anthropic')).resolves.toEqual({ kind: 'picker' })
  })
})

describe('isCustomEndpointSlug', () => {
  it('matches the custom/local family and nothing else', () => {
    expect(isCustomEndpointSlug('custom')).toBe(true)
    expect(isCustomEndpointSlug('local')).toBe(true)
    expect(isCustomEndpointSlug('custom:vllm')).toBe(true)
    expect(isCustomEndpointSlug('localai')).toBe(false)
    expect(isCustomEndpointSlug('openrouter')).toBe(false)
    expect(isCustomEndpointSlug('')).toBe(false)
  })
})
