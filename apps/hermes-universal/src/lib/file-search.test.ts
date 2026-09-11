import { describe, expect, it } from 'vitest'

import {
  bodyHasEntries,
  collectLocalHits,
  compareHits,
  entriesToHits,
  type FileSearchHit,
  localBasenameRank,
  nextSelectionIndex,
  parentLabel,
  resolveSearchHits,
  type SearchableNode,
  shouldQueryServer,
  verdictFromBody,
  verdictFromFailure
} from './file-search'

// The pure half of the file-tree search. Everything here runs with no webview,
// no socket and no device (rule 35) — which is the point: the feature-detection
// contract below is the one thing that decides whether a perfectly good gateway
// gets marked stale for the rest of a session, and it must be pinnable without
// standing up a backend.

const node = (id: string, name: string, extra: Partial<SearchableNode> = {}): SearchableNode => ({
  id,
  isDirectory: false,
  name,
  ...extra
})

const TREE: SearchableNode[] = [
  node('/repo/src', 'src', {
    children: [
      node('/repo/src/index.ts', 'index.ts'),
      node('/repo/src/appChrome.tsx', 'appChrome.tsx'),
      node('/repo/src/nested', 'nested', {
        children: [node('/repo/src/nested/app.ts', 'app.ts')],
        isDirectory: true
      })
    ],
    isDirectory: true
  }),
  node('/repo/README.md', 'README.md')
]

describe('localBasenameRank', () => {
  it('tiers a match the way the gateway does', () => {
    expect(localBasenameRank('app.ts', 'app.ts')).toBe(0)
    expect(localBasenameRank('appChrome.tsx', 'app')).toBe(1)
    expect(localBasenameRank('appChrome.tsx', 'chrome')).toBe(2)
    expect(localBasenameRank('appChrome.tsx', 'hrom')).toBe(3)
  })

  it('rejects a non-substring rather than falling through to subsequence', () => {
    // The gateway ranks a subsequence at tier 4. The LOCAL prefilter must not:
    // its membership has to stay exactly what the old `collectMatches`
    // substring scan showed, because it is what a gateway with no search route
    // falls back to. Only the ORDER improved.
    expect(localBasenameRank('appChrome.tsx', 'ache')).toBeNull()
  })

  it('is case-insensitive in both directions', () => {
    expect(localBasenameRank('README.md', 'readme')).toBe(1)
    expect(localBasenameRank('readme.md', 'README')).toBe(1)
  })
})

describe('collectLocalHits', () => {
  it('walks the whole loaded tree, best match first', () => {
    const hits = collectLocalHits(TREE, 'app')

    expect(hits.map(h => h.path)).toEqual(['/repo/src/nested/app.ts', '/repo/src/appChrome.tsx'])
    // `app.ts` is a tier-1 prefix hit like `appChrome.tsx`, but shorter, so it
    // leads — the deep one, which the old top-down walk emitted second.
    expect(hits[0].rank).toBe(1)
  })

  it('never returns a placeholder row', () => {
    const withPlaceholder = [node('/repo/x::__loading__', 'Loading…', { placeholder: 'loading' })]

    expect(collectLocalHits(withPlaceholder, 'loading')).toEqual([])
  })

  it('honours the cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => node(`/repo/f${i}.ts`, `f${i}.ts`))

    expect(collectLocalHits(many, 'f', 10)).toHaveLength(10)
  })

  it('puts folders ahead of files at the same tier', () => {
    const hits = collectLocalHits(
      [node('/a/thing.ts', 'thing.ts'), node('/a/thing', 'thing', { isDirectory: true })],
      'thing'
    )

    expect(hits[0].path).toBe('/a/thing')
  })
})

describe('feature detection', () => {
  // The contract, restated: the route ALWAYS answers 200 with `entries`, so the
  // body is decisive and the status never is.
  it('reads a present route off the body, including its error shapes', () => {
    expect(verdictFromBody({ entries: [] })).toBe('available')
    expect(verdictFromBody({ entries: [], error: 'ENOENT' })).toBe('available')
    expect(verdictFromBody({ entries: [], error: 'ENOTDIR' })).toBe('available')
  })

  it('reads an absent route off either catch-all body', () => {
    expect(verdictFromFailure(404, JSON.stringify({ detail: 'No such API endpoint: /api/fs/search' }))).toBe(
      'unavailable'
    )
    expect(verdictFromFailure(404, JSON.stringify({ error: 'Frontend not built. Run npm run build.' }))).toBe(
      'unavailable'
    )
  })

  it('refuses to decide on an unauthenticated answer', () => {
    // Both a gateway WITH the route and one without answer 401 here, so a
    // verdict either way is a coin flip — and the harmful side of that coin
    // disables search for the rest of the session on a backend that has it.
    expect(verdictFromFailure(401, '{"detail":"Not authenticated"}')).toBeNull()
    expect(verdictFromFailure(403, '{"detail":"Forbidden"}')).toBeNull()
  })

  it('refuses to decide when there was no answer at all', () => {
    expect(verdictFromFailure(null, '')).toBeNull()
    expect(verdictFromFailure(500, 'boom')).toBeNull()
    expect(verdictFromFailure(502, '<html>bad gateway</html>')).toBeNull()
  })

  it('trusts entries even on a failing status', () => {
    expect(verdictFromFailure(404, JSON.stringify({ entries: [] }))).toBe('available')
  })

  it('does not mistake a non-JSON body for a decision', () => {
    expect(bodyHasEntries('entries')).toBe(false)
    expect(bodyHasEntries(null)).toBe(false)
    expect(bodyHasEntries({ entries: 'nope' })).toBe(false)
  })
})

describe('entriesToHits', () => {
  it('carries the rank and defaults a missing one to the substring tier', () => {
    const hits = entriesToHits([
      { isDirectory: false, name: 'a.ts', path: '/r/a.ts', rank: 0 },
      { isDirectory: true, name: 'b', path: '/r/b' }
    ])

    expect(hits.map(h => h.rank)).toEqual([0, 3])
  })

  it('drops a row with no path and derives a missing name', () => {
    expect(entriesToHits([{ name: 'x' }, { path: '/r/deep/c.ts', rank: 1 }])).toEqual([
      { isDirectory: false, name: 'c.ts', path: '/r/deep/c.ts', rank: 1 }
    ])
  })

  it('survives a body that is not an array', () => {
    expect(entriesToHits(undefined)).toEqual([])
  })
})

describe('the local/server handoff', () => {
  const local: FileSearchHit[] = [{ isDirectory: false, name: 'a.ts', path: '/r/a.ts', rank: 3 }]
  const server: FileSearchHit[] = [{ isDirectory: false, name: 'b.ts', path: '/r/deep/b.ts', rank: 0 }]

  it('shows the prefilter while the request is in flight', () => {
    expect(resolveSearchHits({ available: null, local, server: null })).toEqual({ hits: local, source: 'local' })
  })

  it('replaces it once the ranked answer lands', () => {
    expect(resolveSearchHits({ available: true, local, server })).toEqual({ hits: server, source: 'server' })
  })

  it('replaces it with an EMPTY ranked answer too', () => {
    // "The gateway looked and found nothing" is an answer, and showing the
    // prefilter's stale guesses over it would be a lie about what was searched.
    expect(resolveSearchHits({ available: true, local, server: [] })).toEqual({ hits: [], source: 'server' })
  })

  it('falls back to the prefilter forever on a gateway without the route', () => {
    expect(resolveSearchHits({ available: false, local, server })).toEqual({ hits: local, source: 'local' })
  })

  it('never probes with an empty query, and never re-probes a known-missing route', () => {
    // An empty `q` legally returns up to `limit` entries at rank 3, so it can
    // tell a match from a listing exactly as well as a coin can.
    expect(shouldQueryServer('', null)).toBe(false)
    expect(shouldQueryServer('   ', null)).toBe(false)
    expect(shouldQueryServer('app', false)).toBe(false)
    expect(shouldQueryServer('app', null)).toBe(true)
    expect(shouldQueryServer('app', true)).toBe(true)
  })
})

describe('presentation', () => {
  it('shows the parent relative to the tree root', () => {
    expect(parentLabel('/repo/src/nested/app.ts', '/repo')).toBe('src/nested')
    expect(parentLabel('/repo/README.md', '/repo')).toBe('')
    expect(parentLabel('/repo/README.md', '/repo/')).toBe('')
  })

  it('leaves a path outside the root alone', () => {
    expect(parentLabel('/other/place/x.ts', '/repo')).toBe('/other/place')
  })

  it('clamps the selection instead of wrapping, and survives a shrinking list', () => {
    expect(nextSelectionIndex(-1, 1, 3)).toBe(0)
    expect(nextSelectionIndex(-1, -1, 3)).toBe(2)
    expect(nextSelectionIndex(2, 1, 3)).toBe(2)
    expect(nextSelectionIndex(0, -1, 3)).toBe(0)
    // The answer landed under a held arrow key and the list got shorter.
    expect(nextSelectionIndex(9, 1, 3)).toBe(2)
    expect(nextSelectionIndex(0, 1, 0)).toBe(-1)
  })

  it('sorts by tier, then name length, then folders, then path', () => {
    const hits: FileSearchHit[] = [
      { isDirectory: false, name: 'z', path: '/r/zzzz', rank: 1 },
      { isDirectory: false, name: 'a', path: '/r/aaaa', rank: 1 },
      { isDirectory: true, name: 'd', path: '/r/dddd', rank: 1 },
      { isDirectory: false, name: 'x', path: '/r/x', rank: 0 }
    ]

    expect([...hits].sort(compareHits).map(h => h.path)).toEqual(['/r/x', '/r/dddd', '/r/aaaa', '/r/zzzz'])
  })
})
