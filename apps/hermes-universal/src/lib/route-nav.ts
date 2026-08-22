// Route changes from outside React. The app mounts a HashRouter (main.tsx), so
// writing `location.hash` is the same navigation the `useNavigate` hook performs
// — this exists for stores and other non-component callers (e.g. the composer's
// completion actions, which run from a plain callback table).

type NavigateFn = (to: string, options?: { replace?: boolean }) => void
let navigateImpl: NavigateFn | null = null

/** Call once from a component under HashRouter. */
export function bindNavigate(navigate: NavigateFn): void {
  navigateImpl = navigate
}

export function navigateTo(path: string): void {
  const target = path.startsWith('/') ? path : `/${path}`

  if (typeof window === 'undefined') {
    if (navigateImpl) {
      navigateImpl(target)

      return
    }
  }

  // Only before the router has mounted (boot / tests).
  if (typeof window !== 'undefined') {
    window.location.hash = `#${target}`
  }
}
