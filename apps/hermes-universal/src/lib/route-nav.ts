// Route changes from outside React. The app mounts a HashRouter (main.tsx), so
// writing `location.hash` is the same navigation the `useNavigate` hook performs
// — this exists for stores and other non-component callers (e.g. the composer's
// completion actions, which run from a plain callback table).

/** Navigate to an in-app path (`/command-center?section=sessions`). */
export function navigateTo(path: string): void {
  const target = path.startsWith('/') ? path : `/${path}`

  if (typeof window === 'undefined') {
    return
  }

  window.location.hash = `#${target}`
}
