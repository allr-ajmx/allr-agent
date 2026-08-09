import { getGlobalModelOptions, type HermesGateway, type ModelOptionsResponse } from '@/hermes'

interface ModelOptionsRequest {
  /** When false, include ambient/unconfigured providers (onboarding/setup
   *  surfaces). Chat pickers default to true so only explicitly configured
   *  providers are listed (#56974). */
  explicitOnly?: boolean
  gateway?: HermesGateway
  refresh?: boolean
  sessionId?: null | string
}

/**
 * The one React Query key every `model.options` consumer uses. Scoped by
 * PROFILE as well as session: the catalog a profile sees depends on the
 * credentials that profile is configured with, so a profile switch must not
 * serve the previous profile's providers out of cache. A null/blank profile
 * normalizes to `default` (the root profile), matching `normalizeProfileKey`.
 *
 * Sessionless surfaces (Settings, a pre-session composer) pass no session and
 * share the `global` bucket. Invalidating the bare `['model-options']` prefix
 * still clears every profile and session at once.
 */
export function modelOptionsQueryKey(profile: null | string | undefined, sessionId?: null | string) {
  const profileKey = (profile ?? '').trim() || 'default'

  return ['model-options', profileKey, sessionId || 'global'] as const
}

export function requestModelOptions({
  explicitOnly = true,
  gateway,
  refresh = false,
  sessionId
}: ModelOptionsRequest): Promise<ModelOptionsResponse> {
  if (gateway) {
    const params: Record<string, unknown> = {}

    if (sessionId) {
      params.session_id = sessionId
    }

    if (refresh) {
      params.refresh = true
    }

    if (explicitOnly) {
      params.explicit_only = true
    }

    return gateway.request<ModelOptionsResponse>('model.options', params)
  }

  return getGlobalModelOptions({ explicitOnly, ...(refresh ? { refresh: true } : {}) })
}
