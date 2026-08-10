/**
 * FIND THE ROW FOR A STORED SESSION ID, wherever it happens to live.
 *
 * `$sessions` is the RECENTS PAGE — a paginated window, not the set of sessions
 * that exist. Every surface that renders a session by id resolved it with a
 * `$sessions.find(...)` and treated a miss as "unknown", so anything outside
 * that window lost its identity: a tab for an older session fell back to the
 * literal string `'Session'`, the main tab read `'New session'` for a chat that
 * was neither new nor unnamed, and both lost their accent colour — because the
 * colour resolver takes a `SessionInfo` and there was none to give it
 * (MJXHRM-386).
 *
 * Two more places hold real rows, and between them they cover the cases a tab
 * can actually be open for:
 *
 *  - `$pinnedSessionCache` — the last-known row for every pinned session,
 *    persisted precisely so the Pinned list survives pagination.
 *  - `$projectTree` — the backend's project → repo → lane tree, which carries
 *    the full `SessionInfo` for every session it lists, and is what the sidebar
 *    renders once a project is entered.
 *
 * It lives in its own module because `store/session` cannot import
 * `store/projects` (projects already imports session), and it takes the atoms as
 * arguments nowhere: a tab's title is read during a sync, not during a render,
 * so the caller subscribes and this stays a plain lookup.
 */

import { $projectTree } from '@/store/projects'
import { $pinnedSessionCache, $sessions, sessionMatchesStoredId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

/** The atoms `sessionRowFor` reads. Pass these to a pane mirror's `also` (or
 *  subscribe to them in a component) so a title resolved through the wider
 *  lookup refreshes when a later source lands. */
export const SESSION_ROW_SOURCES = [$sessions, $pinnedSessionCache, $projectTree] as const

/**
 * The row for a stored session id, searched widest-last: the loaded recents
 * page, then the pinned cache, then the project tree. Null only when no source
 * has ever seen the session — a genuinely unknown id, which is the one case a
 * caller should render a placeholder for.
 */
export function sessionRowFor(storedSessionId: null | string): null | SessionInfo {
  if (!storedSessionId) {
    return null
  }

  const loaded = $sessions.get().find(session => sessionMatchesStoredId(session, storedSessionId))

  if (loaded) {
    return loaded
  }

  const cached = Object.values($pinnedSessionCache.get()).find(session =>
    sessionMatchesStoredId(session, storedSessionId)
  )

  if (cached) {
    return cached
  }

  for (const project of $projectTree.get()) {
    for (const repo of project.repos) {
      for (const group of repo.groups) {
        const hit = group.sessions.find(session => sessionMatchesStoredId(session, storedSessionId))

        if (hit) {
          return hit
        }
      }
    }

    const preview = project.previewSessions?.find(session => sessionMatchesStoredId(session, storedSessionId))

    if (preview) {
      return preview
    }
  }

  return null
}
