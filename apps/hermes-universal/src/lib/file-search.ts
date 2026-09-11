// The pure decision half of the file-tree search (rule 35): the match ranking,
// the local-prefilter-vs-server handoff, and the verdict that decides whether
// the gateway even HAS the search route.
//
// Nothing here touches the webview, a socket or a device — it is numbers and
// strings in, numbers and strings out — so `file-search.test.ts` pins every
// invariant without mounting anything. The impure halves are
// `store/file-search.ts` (the request + the degradation atom) and
// `app/right-pane/files/use-file-search.ts` (the debounce + the staleness
// guard).

/** The gateway's own default page size for `/api/fs/search` (it caps at 500). */
export const FILE_SEARCH_LIMIT = 50

/** Cap the flat result list: past this it stops being scannable and starts
 *  being another tree to scroll. */
export const FILTER_RESULT_CAP = 200

/**
 * One search result, in `fs_list`'s entry shape plus the gateway's `rank`.
 *
 * `rank` is the ranker's primary tier — 0 = exact basename, 1 = basename
 * prefix, 2 = word-boundary / camelCase hit, 3 = substring anywhere, 4 =
 * subsequence. Lower is better. The local prefilter produces tiers 0–3 with the
 * same meaning, so a local row and a server row sort against each other
 * sensibly and the list does not visibly reshuffle when the answer lands.
 */
export interface FileSearchHit {
  isDirectory: boolean
  name: string
  path: string
  rank: number
}

/**
 * The shape the local prefilter walks. Deliberately structural rather than an
 * import of `TreeNode`: it keeps this module free of the app graph, and
 * `TreeNode` is assignable to it.
 */
export interface SearchableNode {
  children?: SearchableNode[]
  id: string
  isDirectory: boolean
  name: string
  placeholder?: string
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Split a basename the way the gateway's ranker does: on `-_.` and on a
 *  camelCase hump (`appChrome.tsx` → `app`, `Chrome`, `tsx`). */
function nameParts(name: string): string[] {
  const parts: string[] = []
  let buf = ''

  for (const ch of name) {
    const separator = ch === '-' || ch === '_' || ch === '.'
    const hump = ch >= 'A' && ch <= 'Z' && buf.length > 0 && buf[buf.length - 1] !== buf[buf.length - 1].toUpperCase()

    if (separator || hump) {
      if (buf) {
        parts.push(buf)
      }

      buf = separator ? '' : ch
    } else {
      buf += ch
    }
  }

  if (buf) {
    parts.push(buf)
  }

  return parts
}

/**
 * Rank a basename against a query — or `null` when it does not match at all.
 *
 * Tiers 0–3 are `tui_gateway/file_search.py`'s `_fuzzy_basename_rank`, minus
 * its tier-4 subsequence arm. That omission is deliberate: this is the LOCAL
 * prefilter, and its membership must stay exactly what `collectMatches` has
 * always shown (a plain substring scan) so the fallback path — an older gateway
 * with no search route — behaves as it does today. Only the ORDER improves.
 */
export function localBasenameRank(name: string, query: string): null | number {
  if (!query) {
    return 3
  }

  const nl = name.toLowerCase()
  const ql = query.toLowerCase()

  if (nl === ql) {
    return 0
  }

  if (nl.startsWith(ql)) {
    return 1
  }

  if (!nl.includes(ql)) {
    return null
  }

  for (const part of nameParts(name)) {
    if (part.toLowerCase().startsWith(ql)) {
      return 2
    }
  }

  return 3
}

/**
 * Best-first ordering, matching the gateway's tie-breaks exactly.
 *
 * `rank_search_matches` sorts on `(tier, len(name)), not is_dir, len(rel), rel`
 * — the name length is the ranker's own SECONDARY key, packed into the tuple
 * beside the tier, and it is what puts `app.ts` above `appChrome.tsx` for the
 * query `app` when both are tier-1 prefix hits. Dropping it here would give the
 * local prefilter a different order from the answer that replaces it, so the
 * list would visibly reshuffle for no reason the user can see.
 */
export function compareHits(a: FileSearchHit, b: FileSearchHit): number {
  return (
    a.rank - b.rank ||
    a.name.length - b.name.length ||
    Number(b.isDirectory) - Number(a.isDirectory) ||
    a.path.length - b.path.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  )
}

/**
 * Rank whatever of the tree is ALREADY loaded.
 *
 * This is the instant half of the search: it costs nothing, it needs no round
 * trip, and it is the whole answer when the gateway predates the route. It can
 * only ever see expanded folders, which is precisely the limitation the server
 * route exists to remove.
 */
export function collectLocalHits(
  nodes: SearchableNode[],
  query: string,
  cap: number = FILTER_RESULT_CAP
): FileSearchHit[] {
  const out: FileSearchHit[] = []

  const walk = (level: SearchableNode[]): void => {
    for (const node of level) {
      if (out.length >= cap) {
        return
      }

      if (!node.placeholder) {
        const rank = localBasenameRank(node.name, query)

        if (rank !== null) {
          out.push({ isDirectory: node.isDirectory, name: node.name, path: node.id, rank })
        }
      }

      if (node.children?.length) {
        walk(node.children)
      }
    }
  }

  walk(nodes)

  return out.sort(compareHits)
}

/** Normalise the wire entries into hits, dropping anything malformed. A body
 *  that reached here already passed {@link bodyHasEntries}, so this is about a
 *  single bad ROW, not a bad response. */
export function entriesToHits(entries: unknown): FileSearchHit[] {
  if (!Array.isArray(entries)) {
    return []
  }

  const hits: FileSearchHit[] = []

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') {
      continue
    }

    const entry = raw as Record<string, unknown>
    const path = typeof entry.path === 'string' ? entry.path : ''

    if (!path) {
      continue
    }

    hits.push({
      isDirectory: entry.isDirectory === true,
      name: typeof entry.name === 'string' && entry.name ? entry.name : basename(path),
      path,
      // An older/odd body without a rank still sorts, at the substring tier.
      rank: typeof entry.rank === 'number' && Number.isFinite(entry.rank) ? entry.rank : 3
    })
  }

  return hits
}

// ---------------------------------------------------------------------------
// Feature detection — on the BODY, never on the status
// ---------------------------------------------------------------------------

/**
 * The whole probe: does this response carry an `entries` array?
 *
 * `/api/fs/search` answers 200 with `entries` for everything it can be asked,
 * including a path that does not exist (`{entries: [], error: 'ENOENT'}`) and a
 * path that is a file (`ENOTDIR`). A gateway that does not have the route 404s
 * from one of two catch-alls — `{detail: 'No such API endpoint: …'}` or
 * `{error: 'Frontend not built…'}` — and neither carries `entries`. So the
 * status is ambiguous and the body is not.
 */
export function bodyHasEntries(body: unknown): boolean {
  return Boolean(body) && typeof body === 'object' && Array.isArray((body as { entries?: unknown }).entries)
}

/** `null` = we still do not know; the atom stays untouched. */
export type SearchRouteVerdict = 'available' | 'unavailable' | null

/** The verdict from a 2xx answer. */
export function verdictFromBody(body: unknown): SearchRouteVerdict {
  return bodyHasEntries(body) ? 'available' : 'unavailable'
}

/**
 * The verdict from a non-2xx answer (or from no answer at all, `status: null`).
 *
 * Two cases must NOT degrade the capability, because neither says anything
 * about the route:
 *
 *  * **401 / 403.** Unauthenticated, both a gateway with the route and one
 *    without answer exactly this. Probing before the session token is attached
 *    is how a working gateway gets marked stale for the rest of the session.
 *  * **A transport failure or a 5xx.** No answer is not an answer of "no".
 */
export function verdictFromFailure(status: null | number, body: string): SearchRouteVerdict {
  if (status === null || status === 401 || status === 403 || status >= 500) {
    return null
  }

  // Belt and braces: if the failing body somehow carries `entries`, the route
  // is there and something else went wrong.
  if (bodyHasEntries(parseJson(body))) {
    return 'available'
  }

  return status === 404 ? 'unavailable' : null
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

/**
 * Is it worth asking the gateway?
 *
 * Never for an empty query — an empty `q` legally returns up to `limit` entries
 * at rank 3, so it is both a useless answer and a useless PROBE (it cannot tell
 * a match from a listing). And never once the route is known to be missing.
 */
export function shouldQueryServer(query: string, available: boolean | null): boolean {
  return query.trim().length > 0 && available !== false
}

export interface ResolvedSearch {
  hits: FileSearchHit[]
  /** Which half produced `hits`. The UI uses it for the "loaded folders only"
   *  wording, so it must not lie. */
  source: 'local' | 'server'
}

/**
 * What the list should show right now.
 *
 * The local prefilter paints instantly and the ranked answer replaces it — the
 * point being that the list is never empty while a request is in flight. When
 * the route is known missing there is no server half at all and the local scan
 * IS the feature, exactly as it was before this stage.
 */
export function resolveSearchHits({
  available,
  local,
  server
}: {
  available: boolean | null
  local: FileSearchHit[]
  server: FileSearchHit[] | null
}): ResolvedSearch {
  if (available === false || server === null) {
    return { hits: local, source: 'local' }
  }

  return { hits: server, source: 'server' }
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure, so the row renderer stays dumb)
// ---------------------------------------------------------------------------

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))

  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

/** The parent directory a row shows under its name, relative to the tree root.
 *  Empty for a root-level entry (there is nothing useful to say). */
export function parentLabel(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '')
  const relative = base && path.startsWith(base) ? path.slice(base.length).replace(/^[\\/]+/, '') : path
  const slash = relative.lastIndexOf('/')

  return slash > 0 ? relative.slice(0, slash) : ''
}

/**
 * Where ↑/↓ moves the selection.
 *
 * Clamped rather than wrapping, and it survives a result list that shrank under
 * the cursor (the answer landing while an arrow key is held) by never returning
 * an index the list does not have. `-1` means "nothing selected", which is what
 * an empty list always resolves to.
 */
export function nextSelectionIndex(index: number, delta: number, count: number): number {
  if (count <= 0) {
    return -1
  }

  if (index < 0) {
    return delta > 0 ? 0 : count - 1
  }

  return Math.max(0, Math.min(count - 1, index + delta))
}
