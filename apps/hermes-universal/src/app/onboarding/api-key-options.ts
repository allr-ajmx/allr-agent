import { useQuery } from '@tanstack/react-query'

import { sortProviders } from '@/app/settings/oauth-provider-display'
import { getGlobalModelOptions, listOAuthProviders } from '@/hermes'
import { prettyName } from '@/lib/text'
import type { OAuthProvider } from '@/types/hermes'

// Curated API-key providers (ported from apps/desktop/src/components/onboarding).
// The `local` entry points OPENAI_BASE_URL at a self-hosted OpenAI-compatible
// endpoint. Copy (short/description) comes from t.onboarding.apiKeyOptions[id].
export interface ApiKeyOption {
  id: string
  name: string
  envKey: string
  docsUrl?: string
  placeholder?: string
}

export const LOCAL_ENV_KEY = 'OPENAI_BASE_URL'

export const API_KEY_OPTIONS: ApiKeyOption[] = [
  { id: 'openrouter', name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', docsUrl: 'https://openrouter.ai/keys' },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    docsUrl: 'https://app.fireworks.ai/settings/users/api-keys'
  },
  { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Google Gemini', envKey: 'GEMINI_API_KEY', docsUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'xai', name: 'xAI Grok', envKey: 'XAI_API_KEY', docsUrl: 'https://console.x.ai/' },
  {
    id: 'local',
    name: 'Local / custom endpoint',
    envKey: LOCAL_ENV_KEY,
    docsUrl: 'https://github.com/NousResearch/hermes-agent#bring-your-own-endpoint',
    placeholder: 'http://127.0.0.1:8000/v1'
  }
]

// The full api_key provider catalog: curated entries first (richer copy), then
// every other `auth_type==='api_key'` provider the backend knows about. Best
// effort — the curated defaults still render if the fetch fails.
export function useApiKeyCatalog(): ApiKeyOption[] {
  const { data } = useQuery({ queryKey: ['model-options'], queryFn: () => getGlobalModelOptions(), staleTime: 60_000 })

  const seen = new Set(API_KEY_OPTIONS.map(o => o.envKey))
  const derived: ApiKeyOption[] = []

  for (const provider of data?.providers ?? []) {
    if (provider.auth_type === 'api_key' && provider.key_env && !seen.has(provider.key_env)) {
      seen.add(provider.key_env)
      derived.push({ id: provider.slug, name: provider.name || prettyName(provider.slug), envKey: provider.key_env })
    }
  }

  return [...API_KEY_OPTIONS, ...derived]
}

// OAuth-capable providers for the picker, in the same order Settings → Providers
// uses. `external` (CLI-managed) providers are included: picking one lands on the
// in-picker CLI panel (copyable `cli_command` + recheck), the same flow the
// Settings connect overlay drives. Already-connected providers stay filtered out
// — Settings tags them "Connected", but offering them in a first-run picker is
// just noise (a deliberate narrowing vs. desktop's provider list).
export function useOAuthProviders(): OAuthProvider[] {
  const { data } = useQuery({ queryKey: ['oauth-providers'], queryFn: listOAuthProviders, staleTime: 60_000 })

  return sortProviders((data?.providers ?? []).filter(p => !p.status.logged_in))
}
