import { useEffect, useMemo, useState } from 'react'

import {
  collectLocalHits,
  type FileSearchHit,
  resolveSearchHits,
  type SearchableNode,
  shouldQueryServer
} from '@/lib/file-search'
import { useStore } from '@/store/atom'
import { $fileSearchAvailable, searchFiles } from '@/store/file-search'

/** Matches `use-at-completions.ts`. Long enough that walking a word is one
 *  request rather than eight, short enough to feel like typing. */
const DEBOUNCE_MS = 60

export interface FileSearchResult {
  /** Whether the gateway's ranked search is reachable at all. `false` puts the
   *  bar into its local-only mode, which the placeholder says out loud. */
  available: boolean | null
  hits: FileSearchHit[]
  /** A request is in flight; `hits` is the local prefilter in the meantime. */
  loading: boolean
  source: 'local' | 'server'
}

/**
 * The file tree's search: an instant local prefilter, replaced by the gateway's
 * ranked answer.
 *
 * Two things this hook exists to get right.
 *
 * **The epoch.** Results are keyed on `cwd` as well as the query, and read back
 * only when both still match. Keying the REQUEST alone is not enough — the
 * lesson `use-at-completions.ts:101` writes down from the other side: a stale
 * answer that is merely "for a query I am still showing" is not the same as
 * one for the tree I am currently rooted at, and switching workspace with a
 * query in the box would otherwise leave the previous project's paths on screen
 * until the new answer landed. Comparing the epoch at READ time means there is
 * not even a single frame of it.
 *
 * **Abort.** The Rust `http_request` transport has no cancel handle (there is no
 * `AbortSignal` anywhere in `transport/http.ts`), so "abortable" here means two
 * real things: the debounce timer is cleared before it ever dispatches, and a
 * request that did dispatch has its answer discarded by the epoch check rather
 * than applied late over a newer one. Nothing races.
 */
export function useFileSearch({
  cwd,
  data,
  query
}: {
  cwd: string
  data: SearchableNode[]
  query: string
}): FileSearchResult {
  const available = useStore($fileSearchAvailable)
  const trimmed = query.trim()
  const epoch = `${cwd}|${trimmed}`

  const [answer, setAnswer] = useState<null | { epoch: string; hits: FileSearchHit[] }>(null)
  const [pendingEpoch, setPendingEpoch] = useState<null | string>(null)

  const local = useMemo(() => (trimmed ? collectLocalHits(data, trimmed) : []), [data, trimmed])

  useEffect(() => {
    if (!shouldQueryServer(trimmed, available)) {
      setPendingEpoch(null)

      return
    }

    let live = true

    setPendingEpoch(epoch)

    const timer = setTimeout(() => {
      void searchFiles(cwd, trimmed).then(hits => {
        if (live) {
          setAnswer({ epoch, hits })
          setPendingEpoch(current => (current === epoch ? null : current))
        }
      })
    }, DEBOUNCE_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [available, cwd, epoch, trimmed])

  const server = answer && answer.epoch === epoch ? answer.hits : null
  const { hits, source } = resolveSearchHits({ available, local, server })

  return { available, hits, loading: pendingEpoch === epoch, source }
}
