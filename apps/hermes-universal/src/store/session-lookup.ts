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
 * `store/projects` (projects already imports session).
 *
 * `sessionRowFor` itself is a PLAIN LOOKUP that subscribes to nothing — most of
 * its callers read a title during a pane-mirror sync, not during a render, and
 * hand `SESSION_ROW_SOURCES` to their own listener list. `useSessionRow` is the
 * render-time face of the same thing, and it lives here rather than at the call
 * site so "what the lookup reads" and "what a component subscribes to" cannot
 * drift apart.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'

import { sessionTitle } from '@/lib/chat-runtime'
import { useStore } from '@/store/atom'
import { $projectTree } from '@/store/projects'
import { $pinnedSessionCache, $sessions, sessionMatchesStoredId, sessionPinId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

/** The atoms `sessionRowFor` reads. Pass these to a pane mirror's `also`, or to
 *  a module-level listener list, so a title resolved through the wider lookup
 *  refreshes when a later source lands. Components want `useSessionRow`. */
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

/**
 * `sessionRowFor` as a hook — the row, and a subscription to every source it
 * might have found it in.
 *
 * The subscription breadth is the whole point. A component that resolves a
 * session through the wider lookup but subscribes only to `$sessions` renders
 * correctly ONCE and then never updates when the pinned cache or the project
 * tree lands — the fallback sources would be silently dead on any surface that
 * mounts before them.
 *
 * The sources are destructured out of `SESSION_ROW_SOURCES` rather than
 * imported again, so the tuple stays the one list. They are then subscribed
 * INDIVIDUALLY and in a fixed order, because hooks cannot be called in a loop —
 * add a source to the tuple and you must add a `useStore` here with it.
 */
export function useSessionRow(storedSessionId: null | string): null | SessionInfo {
  const [recents, pinnedCache, projectTree] = SESSION_ROW_SOURCES

  useStore(recents)
  useStore(pinnedCache)
  useStore(projectTree)

  return sessionRowFor(storedSessionId)
}

/** The three scalars a tab's context menu actually renders. */
export interface SessionRowScalars {
  /** DURABLE pin key — the lineage root when a row is known, the raw stored id
   *  otherwise (matching what the sidebar row keys pins by). */
  pinId: string
  profile?: string
  /** `null` until some source has seen the session, so the caller can render its
   *  own placeholder rather than being handed a fabricated title. */
  title: null | string
}

/**
 * The NARROW face of `useSessionRow` (ported from desktop's `useTileMenuRow` —
 * MJXHRM-45).
 *
 * `useSessionRow` subscribes to all three sources WHOLE, which is right when the
 * caller needs the row itself. A tab's context menu does not: it renders three
 * scalars. One of these wrappers is mounted per open tab, permanently, for a menu
 * that is almost never open — so any recents poll, any other session's title
 * update, any project-tree write re-rendered every one of them.
 *
 * Deriving through `useSyncExternalStore` with a keyed cache means the snapshot
 * keeps its identity unless one of the three scalars actually moves, so React
 * bails. The subscription still covers every source, so a tab whose zone mounted
 * before the project tree landed still retitles itself when it arrives — the
 * property `useSessionRow`'s doc comment exists to protect.
 */
export function useSessionRowScalars(storedSessionId: string): SessionRowScalars {
  const cache = useRef<{ key: string; value: SessionRowScalars } | null>(null)

  const subscribe = useCallback((onChange: () => void) => {
    const offs = SESSION_ROW_SOURCES.map(source => source.listen(onChange))

    return () => offs.forEach(off => off())
  }, [])

  return useSyncExternalStore(subscribe, () => {
    const stored = sessionRowFor(storedSessionId)
    const pinId = stored ? sessionPinId(stored) : storedSessionId
    const title = stored ? sessionTitle(stored) : null
    const profile = stored?.profile
    // NUL-joined so a title containing the separator can't collide with a
    // different (pinId, title, profile) triple.
    const key = `${pinId}\u0000${title ?? ''}\u0000${profile ?? ''}`

    if (cache.current?.key !== key) {
      cache.current = { key, value: { pinId, profile, title } }
    }

    return cache.current.value
  })
}
