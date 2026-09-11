import { ApiError } from '@/lib/api'
import { searchDesktopDir } from '@/lib/desktop-fs'
import {
  bodyHasEntries,
  entriesToHits,
  FILE_SEARCH_LIMIT,
  type FileSearchHit,
  verdictFromBody,
  verdictFromFailure
} from '@/lib/file-search'
import { atom } from '@/store/atom'

// The impure half of the file tree's search: the one request, and the capability
// it degrades on. Every decision it makes lives in `lib/file-search.ts` (rule
// 35), which is why this file is short enough to read in one pass.

/**
 * False once a gateway has proved it has no `/api/fs/search`; `null` until
 * something has asked.
 *
 * Copies `$projectsRpcAvailable` (`store/projects.ts`) and
 * `$folderDownloadAvailable` (`store/downloads.ts`) because MJXHRM-511 freezes
 * the gateway backend so `hermes-agent` and `allr-agent` stay interchangeable:
 * the search route is ADDITIVE, so a client that hard-depends on it breaks
 * against the other one. False does not hide the search bar — it drops it back
 * to the local, already-loaded-folders-only filter it has always been.
 */
export const $fileSearchAvailable = atom<boolean | null>(null)

/**
 * Ask the gateway to rank `query` under `root`.
 *
 * Feature detection happens HERE, on the BODY rather than the status, and only
 * on an AUTHENTICATED call: an unauthenticated request answers 401 whether or
 * not the route exists, so treating that as "missing" would mark a perfectly
 * good gateway stale for the rest of the session. `verdictFromFailure` is what
 * encodes that; this function only has to hand it the two facts.
 *
 * Callers must not pass an empty query (see `shouldQueryServer`): an empty `q`
 * legally returns up to `limit` entries at rank 3, which is a useless answer and
 * a useless probe. Returns `[]` on any failure — the caller keeps showing the
 * local prefilter, which is a better answer than an error toast for a keystroke.
 */
export async function searchFiles(
  root: string,
  query: string,
  limit: number = FILE_SEARCH_LIMIT
): Promise<FileSearchHit[]> {
  try {
    const body = await searchDesktopDir(root, query, limit)

    applyVerdict(verdictFromBody(body))

    return bodyHasEntries(body) ? entriesToHits(body.entries) : []
  } catch (err) {
    // An `ApiError` carries the status AND the raw body; anything else is a
    // transport failure, which is no answer at all rather than an answer of no.
    applyVerdict(err instanceof ApiError ? verdictFromFailure(err.status, err.body) : verdictFromFailure(null, ''))

    return []
  }
}

function applyVerdict(verdict: 'available' | 'unavailable' | null): void {
  if (verdict === 'available') {
    $fileSearchAvailable.set(true)
  } else if (verdict === 'unavailable') {
    $fileSearchAvailable.set(false)
  }
}

/** Test seam: back to "nothing has asked yet". Also what a gateway switch would
 *  want if this ever grows one (rule 20). */
export function __resetFileSearch(): void {
  $fileSearchAvailable.set(null)
}
