import { listAllProfileSessions } from '@/hermes'
import { atom, computed } from '@/store/atom'
import type { SessionInfo } from '@/types/hermes'

import { $sessions } from './session'

// Ported from desktop `store/sidebar-archive.ts`.
//
// Archived rows are excluded from the sessions query, so the Archived view has
// to fetch its own set. Capped: it's a lookup surface, not a feed.
const ARCHIVED_FETCH_LIMIT = 200

export const $archivedSessions = atom<SessionInfo[]>([])
export const $archivedSessionsLoading = atom(false)

export async function loadArchivedSessions(): Promise<void> {
  if ($archivedSessionsLoading.get()) {
    return
  }

  $archivedSessionsLoading.set(true)

  try {
    const result = await listAllProfileSessions(ARCHIVED_FETCH_LIMIT, 0, 'only')

    $archivedSessions.set(result.sessions)
  } catch {
    $archivedSessions.set([])
  } finally {
    $archivedSessionsLoading.set(false)
  }
}

/** Drop the fetched set because the gateway changed — these are another
 *  backend's rows, and the sidebar would otherwise show them until the next
 *  time the user opens the Archived view. */
export function resetArchivedSessionsForBackendSwitch(): void {
  $archivedSessions.set([])
}

/** Spend on a session — provider-reported price when we have one, our own
 *  estimate otherwise. */
export const sessionCostUsd = (session: SessionInfo): number =>
  session.actual_cost_usd || session.estimated_cost_usd || 0

/** Whether ANY loaded session reports spend. Subscription auth never quotes a
 *  price, so for those users a cost sort would rank a list of zeroes — the
 *  menu hides the option instead of offering a dead one. */
export const $sessionsHaveCost = computed($sessions, sessions => sessions.some(session => sessionCostUsd(session) > 0))
