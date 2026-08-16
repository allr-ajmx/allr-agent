import { QueryClient, type QueryKey } from '@tanstack/react-query'

// Shared React Query client. Lives in its own module (not main.tsx) so non-React
// code — e.g. the profile store on a gateway swap — can invalidate cached,
// profile-scoped settings without importing the app entry point.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000
    }
  }
})

/**
 * Test seam: take React Query's retry ladder off the SHARED client.
 *
 * Called once from `src/test-setup.ts`, so no test file has to remember it.
 *
 * A test cannot simply hand `QueryClientProvider` a fresh client instead: this
 * module's `writeCache` / `invalidateProfileScopedQueries` — and everything
 * built on them, e.g. `settings/use-config-record.ts` — close over the SINGLETON
 * above. A component tree wired to a different client would read from one cache
 * while the code under test wrote to another. That is why a dozen test files
 * pass this exact instance, and it is what makes the retry policy theirs too.
 *
 * React Query's default is 3 retries at 1s/2s/4s, so the first render in which a
 * query REJECTS sits in its loading skeleton for ~7s before the error state
 * appears — past Vitest's 5s `testTimeout`. The failure looks like a slow test
 * and invites raising the timeout; the actual cost is that no test in this app
 * could assert a failed-load state at all.
 */
export function configureQueryClientForTests(): void {
  queryClient.setDefaultOptions({
    queries: {
      refetchOnWindowFocus: false,
      // The whole point: surface the rejection on the first attempt.
      retry: false,
      staleTime: 60_000
    }
  })
}

// Query roots that are account/global rather than per-profile, so a profile
// switch must NOT refetch them. Billing is the motivating case: balance, plan
// and card live on the account, and blowing that cache away on every switch
// cost two gateway RPCs and a visible flicker. Ported from desktop, minus the
// roots universal has no equivalent for.
const PROFILE_INDEPENDENT_QUERY_ROOTS = new Set<string>(['billing', 'marketplace-themes-settings'])

// Invalidate profile-scoped query caches on a profile / gateway switch, leaving
// account/global caches intact. Replaces a keyless invalidateQueries() that
// refetched everything on every switch.
export function invalidateProfileScopedQueries(): void {
  void queryClient.invalidateQueries({
    predicate: query => {
      const root = query.queryKey[0]

      return typeof root !== 'string' || !PROFILE_INDEPENDENT_QUERY_ROOTS.has(root)
    }
  })
}

// Curried, setState-shaped cache writer for optimistic write-through: keeps
// mutation sites terse (`setX(next)` or `setX(prev => …)`) over one query key.
export const writeCache =
  <T>(key: QueryKey) =>
  (next: T | undefined | ((prev: T | undefined) => T | undefined)): void =>
    void queryClient.setQueryData<T>(key, next)
