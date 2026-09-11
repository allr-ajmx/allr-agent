import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api'

// The one impure decision this store makes is which failure degrades the
// capability and which does not — so the transport is the only thing mocked.
const searchDesktopDir = vi.fn()

vi.mock('@/lib/desktop-fs', () => ({
  searchDesktopDir: (path: string, query: string, limit: number) => searchDesktopDir(path, query, limit)
}))

const { $fileSearchAvailable, __resetFileSearch, searchFiles } = await import('./file-search')

beforeEach(() => {
  searchDesktopDir.mockReset()
  __resetFileSearch()
})

describe('searchFiles', () => {
  it('asks the gateway with the query and the limit, and returns ranked hits', async () => {
    searchDesktopDir.mockResolvedValue({
      entries: [{ isDirectory: false, name: 'app.ts', path: '/r/src/app.ts', rank: 0 }]
    })

    const hits = await searchFiles('/r', 'app', 25)

    expect(searchDesktopDir).toHaveBeenCalledWith('/r', 'app', 25)
    expect(hits).toEqual([{ isDirectory: false, name: 'app.ts', path: '/r/src/app.ts', rank: 0 }])
    expect($fileSearchAvailable.get()).toBe(true)
  })

  it('counts an ENOENT answer as the route being PRESENT', () => {
    // The whole feature-detection contract in one test: a missing directory is
    // a 200 with `entries`, and treating it as a missing ROUTE would disable
    // search for the session the first time a stale path was searched.
    searchDesktopDir.mockResolvedValue({ entries: [], error: 'ENOENT' })

    return searchFiles('/gone', 'app').then(hits => {
      expect(hits).toEqual([])
      expect($fileSearchAvailable.get()).toBe(true)
    })
  })

  it('degrades on a 404 whose body has no entries', async () => {
    searchDesktopDir.mockRejectedValue(
      new ApiError('GET /api/fs/search → HTTP 404', 404, JSON.stringify({ detail: 'No such API endpoint' }))
    )

    expect(await searchFiles('/r', 'app')).toEqual([])
    expect($fileSearchAvailable.get()).toBe(false)
  })

  it('does NOT degrade on a 401 — that is the unauthenticated probe trap', async () => {
    searchDesktopDir.mockRejectedValue(new ApiError('GET → HTTP 401', 401, '{"detail":"Not authenticated"}'))

    expect(await searchFiles('/r', 'app')).toEqual([])
    expect($fileSearchAvailable.get()).toBeNull()
  })

  it('does NOT degrade on a transport failure', async () => {
    // No answer is not an answer of "no". A dropped socket must not cost the
    // user their search for the rest of the session.
    searchDesktopDir.mockRejectedValue(new Error('connection reset'))

    expect(await searchFiles('/r', 'app')).toEqual([])
    expect($fileSearchAvailable.get()).toBeNull()
  })

  it('never throws at the caller — a keystroke does not deserve an error toast', async () => {
    searchDesktopDir.mockRejectedValue(new Error('boom'))

    await expect(searchFiles('/r', 'app')).resolves.toEqual([])
  })
})
