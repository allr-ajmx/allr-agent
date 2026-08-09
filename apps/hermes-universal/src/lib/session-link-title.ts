/**
 * Titles for `@session:` chips.
 *
 * The agent writes session links as `@session:<profile>/<id>` — an id, not a
 * name. Rendering the raw id is useless ("20260809_143312_a1b2c3"), so a chip
 * has to resolve a human title, and a transcript can carry the SAME link a
 * dozen times.
 *
 * Hence the shape: a process-lifetime cache, an in-flight map so N chips for
 * one session cost one lookup, and a subscriber set so the one lookup repaints
 * all of them. The sidebar list is consulted first and is free — only an id
 * that is not in it costs a REST round-trip.
 */

import { useEffect, useState } from 'react'

import { getSession } from '@/hermes'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

const titleCache = new Map<string, string>()
const titleInflight = new Map<string, Promise<string>>()
const titleSubs = new Map<string, Set<(value: string) => void>>()

/** Split `@session:` ref VALUE into its profile and session id. The profile
 *  half is optional: `@session:<id>` means "this profile". */
export function parseSessionRefValue(value: string): { profile: null | string; sessionId: string } {
  const trimmed = value.trim()

  if (!trimmed) {
    return { profile: null, sessionId: '' }
  }

  const slash = trimmed.lastIndexOf('/')

  return slash < 0
    ? { profile: null, sessionId: trimmed }
    : { profile: trimmed.slice(0, slash) || null, sessionId: trimmed.slice(slash + 1) }
}

/** Cache key. The profile is part of it: the same id can exist in two profiles
 *  and mean two different conversations. */
const cacheKey = (value: string): string => {
  const { profile, sessionId } = parseSessionRefValue(value)

  return sessionId ? `${profile ?? ''}/${sessionId}` : ''
}

/** The label a chip shows while (or instead of) resolving — a truncated id. */
export function sessionRefFallbackLabel(value: string): string {
  const { sessionId } = parseSessionRefValue(value)

  return sessionId.length > 10 ? `${sessionId.slice(0, 8)}…` : sessionId
}

/**
 * Deliberately NOT `sessionTitle()` from lib/chat-runtime: its "Untitled
 * session" fallback would be a worse chip label than the short id the caller
 * falls back to.
 */
const sessionRowTitle = (row: SessionInfo): string => row.title?.trim() || row.preview?.trim() || ''

const profileMatches = (rowProfile: null | string | undefined, wanted: null | string): boolean =>
  !wanted || (rowProfile ?? '') === wanted

/** The title from the sidebar list — synchronous and free. Empty when the
 *  session is not in the loaded page. */
export function lookupLocalSessionTitle(value: string): string {
  const { profile, sessionId } = parseSessionRefValue(value)

  if (!sessionId) {
    return ''
  }

  const row = $sessions.get().find(session => session.id === sessionId && profileMatches(session.profile, profile))

  return row ? sessionRowTitle(row) : ''
}

/** Never throws: a link to a session on another backend 404s, and a chip must
 *  fall back to its short id rather than surface an error. */
async function requestSessionRow(sessionId: string, profile: null | string): Promise<SessionInfo | null> {
  try {
    return await getSession(sessionId, profile)
  } catch {
    return null
  }
}

/**
 * Resolve a `@session:` ref's title. Resolves to `''` when it cannot be
 * resolved — the caller owns the fallback label.
 */
export function fetchSessionLinkTitle(value: string): Promise<string> {
  const key = cacheKey(value)

  if (!key) {
    return Promise.resolve('')
  }

  // An empty cached value is still an answer: it means "asked, unresolvable",
  // and re-asking on every render would hammer the backend for nothing.
  const cached = titleCache.get(key)

  if (cached !== undefined) {
    return Promise.resolve(cached)
  }

  const inflight = titleInflight.get(key)

  if (inflight) {
    return inflight
  }

  const local = lookupLocalSessionTitle(value)

  if (local) {
    titleCache.set(key, local)

    return Promise.resolve(local)
  }

  const { profile, sessionId } = parseSessionRefValue(value)

  const promise = requestSessionRow(sessionId, profile).then(row => {
    const title = row ? sessionRowTitle(row) : ''
    titleCache.set(key, title)
    titleInflight.delete(key)

    for (const notify of titleSubs.get(key) ?? []) {
      notify(title)
    }

    return title
  })

  titleInflight.set(key, promise)

  return promise
}

/** The resolved title for a `@session:` chip, falling back to a short id. */
export function useSessionLinkTitle(value: string, fallbackLabel?: string): string {
  const key = cacheKey(value)
  // Seeded synchronously so a locally-known title never flashes the fallback.
  const [title, setTitle] = useState(() => titleCache.get(key) ?? lookupLocalSessionTitle(value))

  useEffect(() => {
    if (!key) {
      return
    }

    const known = titleCache.get(key) ?? lookupLocalSessionTitle(value)

    if (known) {
      setTitle(known)

      return
    }

    const subs = titleSubs.get(key) ?? new Set<(value: string) => void>()
    subs.add(setTitle)
    titleSubs.set(key, subs)
    void fetchSessionLinkTitle(value)

    return () => {
      subs.delete(setTitle)

      if (subs.size === 0) {
        titleSubs.delete(key)
      }
    }
  }, [key, value])

  return title || fallbackLabel?.trim() || sessionRefFallbackLabel(value)
}

/** Test hook — drop every cached/in-flight/subscribed entry. */
export function __resetSessionLinkTitleCache(): void {
  titleCache.clear()
  titleInflight.clear()
  titleSubs.clear()
}
