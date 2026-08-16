import { useEffect } from 'react'

import { setComposerActions } from '@/store/composer-actions'

import { type ComposerMicroActionContext, useComposerMicroActionProviders } from '../contrib'

/**
 * Resolve every registered micro-action provider for this session and publish
 * the result to `$composerActionsBySession`, which the pill strip renders.
 *
 * Core registers nothing, so the strip stays empty until something contributes
 * to `composer.microActions`. Providers are pure functions of the session
 * context and the set is recomputed rather than mutated, so there are no
 * ordering games between registrars and a provider that stops returning a
 * badge withdraws it. One that throws is skipped, so a broken plugin loses
 * only its own badge.
 *
 * Desktop also feeds `todos` into the context from `$todosBySession`. Universal
 * has no todo feed, so the field is absent from the context type entirely (see
 * `contrib.ts`) — one line here and one there when the feed lands.
 */
export function useComposerMicroActions(sessionId: null | string, busy: boolean) {
  const providers = useComposerMicroActionProviders()

  useEffect(() => {
    if (!sessionId) {
      return
    }

    const ctx: ComposerMicroActionContext = { busy, sessionId }

    setComposerActions(
      sessionId,
      providers.flatMap(provider => {
        try {
          return provider.resolve(ctx) ?? []
        } catch {
          return []
        }
      })
    )
  }, [busy, providers, sessionId])

  // Withdraw on unmount / session switch ONLY. Clearing in the resolve effect's
  // cleanup would publish an empty set before every republish — two store
  // writes and two stack re-renders for what is usually a no-op.
  useEffect(() => (sessionId ? () => setComposerActions(sessionId, []) : undefined), [sessionId])
}
