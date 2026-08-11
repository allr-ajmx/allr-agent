import { API_KEY_OPTIONS, type ApiKeyOption, LOCAL_ENV_KEY, optionSlug } from '@/app/onboarding/api-key-options'
import {
  cancelOAuthSession,
  getGlobalModelOptions,
  getRecommendedDefaultModel,
  listOAuthProviders,
  pollOAuthSession,
  setEnvVar,
  setModelAssignment,
  startOAuthLogin,
  submitOAuthCode,
  validateProviderCredential
} from '@/hermes'
import type { RecommendedDefaultModel } from '@/hermes'
import { openExternalLink } from '@/lib/external-link'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { atom } from '@/store/atom'
import { requestGateway } from '@/store/gateway'
import type { OAuthProvider } from '@/types/hermes'

// First-run provider-setup wizard state. Adapted (leaned) from apps/desktop/src/
// store/onboarding.ts: the local-runtime boot/Preparing machinery is dropped
// (mobile is remote-only).

export type OnboardingStep = 'picker' | 'apikey' | 'oauth' | 'confirm'

// Provider OAuth sub-flow. device_code → poll until approved; pkce → the user
// pastes an authorization code back; external → a third-party CLI mints the creds
// (Qwen/Copilot/Claude Code…), so we show the command to run + a recheck button
// instead of an in-app browser flow.
export interface OAuthFlowState {
  provider: OAuthProvider
  sessionId: string
  flow: 'device_code' | 'external' | 'pkce'
  url: string
  userCode?: string
  status: 'awaiting_code' | 'error' | 'external_pending' | 'pending' | 'rechecking' | 'submitting'
}

export interface OnboardingState {
  step: OnboardingStep
  option: ApiKeyOption | null
  providerSlug: string | null
  recommended: RecommendedDefaultModel | null
  oauth: OAuthFlowState | null
  busy: boolean
  error: string | null
}

const INITIAL: OnboardingState = {
  step: 'picker',
  option: null,
  providerSlug: null,
  recommended: null,
  oauth: null,
  busy: false,
  error: null
}

// Persisted "user has been through (or dismissed) onboarding" flag — the mobile
// equivalent of desktop's hermes-desktop-onboarded / onboarding-skipped keys.
export const $onboardingSeen = persistentAtom<boolean>('hermes.onboarded', false, Codecs.bool)
export const $onboarding = atom<OnboardingState>(INITIAL)
export const $onboardingActive = atom(false)

// The provider-connect overlay (Settings → Providers → Accounts). Non-null ⇒ the
// focused per-provider connect card is open. Kept SEPARATE from $onboardingActive
// so a settings-triggered connect renders as an overlay ON TOP of the still-mounted
// settings page instead of the full-screen first-run wizard takeover.
export const $connectProvider = atom<OAuthProvider | null>(null)

const patch = (next: Partial<OnboardingState>) => $onboarding.set({ ...$onboarding.get(), ...next })

// ── Provider OAuth polling (device_code) ────────────────────────────────────
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollSession: string | null = null

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
  }

  pollTimer = null
  pollSession = null
}

// `GET /api/model/recommended-default` answers 200 with `model: ""` whenever it
// can't resolve one — a slug outside CANONICAL_PROVIDERS, a catalog that hasn't
// warmed, a provider the freshly-written credential hasn't made "configured"
// yet. That is a success SHAPE meaning nothing, and taking it at face value is
// how the confirm step ends up naming no model and `confirmModel()` ends up
// assigning none. So: treat an empty model as unresolved and fall back to the
// provider's own curated list, the way desktop `fetchProviderDefaultModel` does.
// Returns null when nothing can be resolved — callers must not pretend.
async function resolveDefaultModel(slug: string): Promise<RecommendedDefaultModel | null> {
  const recommended = await getRecommendedDefaultModel(slug).catch(() => null)

  if (recommended?.model) {
    return recommended
  }

  const options = await getGlobalModelOptions({ explicitOnly: false }).catch(() => null)
  const row = (options?.providers ?? []).find(p => p.slug?.toLowerCase() === slug.toLowerCase())
  const model = row?.models?.[0]

  return model && row ? { provider: row.slug, model, free_tier: null } : null
}

async function onProviderConnected(provider: OAuthProvider) {
  stopPolling()
  const recommended = await resolveDefaultModel(provider.id)
  patch({ step: 'confirm', providerSlug: provider.id, recommended, oauth: null, busy: false, error: null })
}

function pollDeviceCode(provider: OAuthProvider, sessionId: string, intervalMs: number) {
  pollSession = sessionId

  const tick = async () => {
    if (pollSession !== sessionId) {
      return
    }

    try {
      const res = await pollOAuthSession(provider.id, sessionId)

      if (pollSession !== sessionId) {
        return
      }

      if (res.status === 'approved') {
        void onProviderConnected(provider)
      } else if (res.status === 'pending') {
        pollTimer = setTimeout(() => void tick(), intervalMs)
      } else {
        stopPolling()
        setOAuth({ status: 'error' })
        patch({ error: res.error_message || 'Sign-in failed. Try again.' })
      }
    } catch {
      // Transient poll error — keep waiting.
      pollTimer = setTimeout(() => void tick(), intervalMs)
    }
  }

  pollTimer = setTimeout(() => void tick(), intervalMs)
}

const setOAuth = (next: Partial<OAuthFlowState>) => {
  const oauth = $onboarding.get().oauth

  if (oauth) {
    patch({ oauth: { ...oauth, ...next } })
  }
}

function finish() {
  stopPolling()
  $onboardingSeen.set(true)
  $onboardingActive.set(false)
  $onboarding.set(INITIAL)
}

/** Skip setup — remembered so we never re-nag. */
export function chooseLater() {
  finish()
}

/** Open the wizard manually (e.g. from Settings), regardless of the seen flag. */
export function openOnboarding() {
  $onboarding.set(INITIAL)
  $onboardingActive.set(true)
}

/** After connect: show the wizard only if no provider is configured (and unseen). */
export async function checkConfigured(): Promise<void> {
  if ($onboardingSeen.get()) {
    return
  }

  try {
    const { providers } = await getGlobalModelOptions()
    const configured = (providers ?? []).some(p => p.authenticated !== false && (p.models?.length ?? 0) > 0)

    if (configured) {
      $onboardingSeen.set(true)

      return
    }

    $onboarding.set(INITIAL)
    $onboardingActive.set(true)
  } catch {
    // A probe failure shouldn't force onboarding on top of a real connection.
  }
}

export function selectApiKeyProvider(option: ApiKeyOption) {
  patch({ step: 'apikey', option, error: null })
}

export function backToPicker() {
  const oauth = $onboarding.get().oauth
  stopPolling()

  if (oauth) {
    void cancelOAuthSession(oauth.sessionId).catch(() => {})
  }

  patch({ step: 'picker', option: null, oauth: null, error: null })
}

/** Begin a provider OAuth sign-in: start the session, open the browser, then
 *  either poll (device_code) or await a pasted code (pkce). */
export async function startProviderOAuth(provider: OAuthProvider): Promise<void> {
  // External (CLI-managed) providers — Qwen/Copilot/Claude Code, etc. — mint their
  // creds through a third-party CLI, so there's no in-app browser OAuth. Show the
  // command to run + a recheck button instead of calling the OAuth endpoints.
  if (provider.flow === 'external') {
    patch({
      busy: false,
      step: 'oauth',
      error: null,
      oauth: { provider, sessionId: '', flow: 'external', url: '', status: 'external_pending' }
    })

    return
  }

  patch({ busy: true, error: null })

  try {
    const start = await startOAuthLogin(provider.id)
    void openExternalLink(start.flow === 'pkce' ? start.auth_url : start.verification_url)

    if (start.flow === 'device_code') {
      patch({
        busy: false,
        step: 'oauth',
        oauth: {
          provider,
          sessionId: start.session_id,
          flow: 'device_code',
          url: start.verification_url,
          userCode: start.user_code,
          status: 'pending'
        }
      })
      pollDeviceCode(provider, start.session_id, Math.max(1, start.poll_interval || 3) * 1000)
    } else {
      patch({
        busy: false,
        step: 'oauth',
        oauth: { provider, sessionId: start.session_id, flow: 'pkce', url: start.auth_url, status: 'awaiting_code' }
      })
    }
  } catch (err) {
    patch({ busy: false, error: err instanceof Error ? err.message : 'Sign-in failed. Try again.' })
  }
}

/** Open the focused per-provider connect overlay (Providers → Accounts) and jump
 *  straight into that provider's OAuth flow — skipping the picker. Does NOT set
 *  $onboardingActive, so the settings page stays mounted underneath (mirrors the
 *  desktop "manual provider OAuth" overlay handoff). */
export function beginProviderConnect(provider: OAuthProvider): void {
  stopPolling()
  $onboarding.set(INITIAL)
  $connectProvider.set(provider)
  void startProviderOAuth(provider)
}

/** Where a "Set up <provider>" hand-off should land.
 *
 *  `custom-endpoint` — an OpenAI-compatible base URL (Ollama, vLLM, llama.cpp…).
 *  It is not an OAuth provider and has no curated env key, so the generic picker
 *  dead-ends it (desktop hit the same "booted back to the first screen" loop and
 *  answered it with `startManualLocalEndpoint`; universal already owns a richer
 *  answer — the Providers → Custom endpoints editor, which does CRUD + validate
 *  + activate in one page).
 *  `oauth` — a provider the gateway can sign in; jump straight into its connect
 *  overlay instead of making the user find it again in the picker.
 *  `picker` — no trustworthy auth metadata; open the generic wizard. */
export type ProviderSetupTarget =
  { kind: 'custom-endpoint' } | { kind: 'oauth'; provider: OAuthProvider } | { kind: 'picker' }

/** `custom`, `local`, and the `custom:<id>` rows the endpoint store synthesises. */
export function isCustomEndpointSlug(slug: string): boolean {
  const s = slug.trim().toLowerCase()

  return s === 'custom' || s === 'local' || s.startsWith('custom:')
}

/** Resolve where a provider slug's setup flow lives. A failed provider lookup
 *  falls back to the picker rather than throwing — setup must stay reachable
 *  even when the OAuth catalog call fails. */
export async function resolveProviderSetup(slug: string): Promise<ProviderSetupTarget> {
  const wanted = slug.trim().toLowerCase()

  if (!wanted) {
    return { kind: 'picker' }
  }

  if (isCustomEndpointSlug(wanted)) {
    return { kind: 'custom-endpoint' }
  }

  try {
    const { providers } = await listOAuthProviders()
    const match = providers.find(p => p.id.trim().toLowerCase() === wanted)

    if (match) {
      return { kind: 'oauth', provider: match }
    }
  } catch {
    // Catalog unreachable — the generic picker still gets the user somewhere.
  }

  return { kind: 'picker' }
}

/** Dismiss the connect overlay: cancel any live session, reset flow state. */
export function cancelProviderConnect(): void {
  stopPolling()
  const oauth = $onboarding.get().oauth

  if (oauth && oauth.sessionId) {
    void cancelOAuthSession(oauth.sessionId).catch(() => {})
  }

  $onboarding.set(INITIAL)
  $connectProvider.set(null)
}

/** Re-check whether an external (CLI-managed) provider is now authenticated after
 *  the user ran its `cli_command` in a terminal. Reloads env, re-lists providers,
 *  and advances to the confirm step on success — else surfaces the "run it first"
 *  hint. Mirrors desktop `recheckExternalSignin`. */
export async function recheckExternalSignin(): Promise<void> {
  const oauth = $onboarding.get().oauth

  if (!oauth || oauth.flow !== 'external') {
    return
  }

  const provider = oauth.provider
  patch({ busy: true, error: null, oauth: { ...oauth, status: 'rechecking' } })

  try {
    // Reload the backend env so freshly-written CLI creds are picked up (best-effort).
    await requestGateway('reload.env').catch(() => {})
    const { providers } = await listOAuthProviders()
    const fresh = providers.find(p => p.id === provider.id)

    if (fresh?.status.logged_in) {
      await onProviderConnected(fresh)

      return
    }

    patch({
      busy: false,
      error: `Hermes still can't reach ${provider.name}. Run \`${provider.cli_command}\` in a terminal first.`,
      oauth: { ...oauth, status: 'external_pending' }
    })
  } catch (err) {
    patch({
      busy: false,
      error: err instanceof Error ? err.message : 'Could not verify sign-in. Try again.',
      oauth: { ...oauth, status: 'external_pending' }
    })
  }
}

/** Submit a PKCE authorization code the user pasted from the browser. */
export async function submitOnboardingCode(code: string): Promise<boolean> {
  const oauth = $onboarding.get().oauth

  if (!oauth || !code.trim()) {
    return false
  }

  setOAuth({ status: 'submitting' })
  patch({ busy: true, error: null })

  try {
    const res = await submitOAuthCode(oauth.provider.id, oauth.sessionId, code.trim())

    if (res.ok && res.status === 'approved') {
      await onProviderConnected(oauth.provider)

      return true
    }

    setOAuth({ status: 'awaiting_code' })
    patch({ busy: false, error: res.message || 'Sign-in failed. Try again.' })

    return false
  } catch (err) {
    setOAuth({ status: 'awaiting_code' })
    patch({ busy: false, error: err instanceof Error ? err.message : 'Sign-in failed. Try again.' })

    return false
  }
}

/** Save a provider's API key (or wire a local endpoint), then advance. */
export async function saveApiKey(option: ApiKeyOption, value: string, localApiKey?: string): Promise<boolean> {
  const trimmed = value.trim()

  if (!trimmed) {
    return false
  }

  patch({ busy: true, error: null })

  try {
    if (option.envKey === LOCAL_ENV_KEY) {
      const res = await validateProviderCredential(LOCAL_ENV_KEY, trimmed, localApiKey)

      if (!res.reachable || !res.models?.length) {
        patch({ busy: false, error: res.message || 'Endpoint unreachable' })

        return false
      }

      await setModelAssignment({
        scope: 'main',
        provider: 'custom',
        base_url: trimmed,
        model: res.models[0],
        api_key: localApiKey
      })
      finish()

      return true
    }

    await setEnvVar(option.envKey, trimmed)
    // The key lands in `.env`; the backend only sees it once its process env is
    // refreshed, and the model lookup below is the first thing that depends on
    // it. Best-effort — the same reload the external-CLI recheck path runs.
    await requestGateway('reload.env').catch(() => {})
    const slug = optionSlug(option)
    const recommended = await resolveDefaultModel(slug)
    patch({ busy: false, step: 'confirm', providerSlug: slug, recommended })

    return true
  } catch (err) {
    patch({ busy: false, error: err instanceof Error ? err.message : 'Could not save credential.' })

    return false
  }
}

/** Confirm the recommended default model for the chosen provider, then done. */
export async function confirmModel(): Promise<boolean> {
  const { providerSlug, recommended } = $onboarding.get()

  if (!providerSlug) {
    return false
  }

  patch({ busy: true, error: null })

  try {
    if (recommended?.model) {
      await setModelAssignment({
        scope: 'main',
        provider: recommended.provider || providerSlug,
        model: recommended.model
      })
    }

    finish()

    return true
  } catch (err) {
    patch({ busy: false, error: err instanceof Error ? err.message : 'Could not set the model.' })

    return false
  }
}

// Re-export for consumers that only need the curated list.
export { API_KEY_OPTIONS }
