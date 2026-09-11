import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchableNode } from '@/lib/file-search'

const store = vi.hoisted(() => ({ searchFiles: vi.fn() }))

vi.mock('@/store/file-search', async () => {
  const { atom } = await import('@/store/atom')

  return {
    $fileSearchAvailable: atom<boolean | null>(null),
    searchFiles: (root: string, query: string) => store.searchFiles(root, query)
  }
})

const { $fileSearchAvailable } = await import('@/store/file-search')
const { useFileSearch } = await import('./use-file-search')

const hit = (path: string, name: string) => ({ isDirectory: false, name, path, rank: 0 })

const TREE: SearchableNode[] = [
  { id: '/one/app.ts', isDirectory: false, name: 'app.ts' },
  { id: '/one/other.ts', isDirectory: false, name: 'other.ts' }
]

/** A request that never settles, so the in-flight window can be inspected. */
const pending = () => new Promise<never>(() => {})

beforeEach(() => {
  store.searchFiles.mockReset()
  $fileSearchAvailable.set(null)
})

describe('useFileSearch', () => {
  it('paints the local prefilter before the request even goes out', () => {
    store.searchFiles.mockImplementation(pending)

    const { result } = renderHook(() => useFileSearch({ cwd: '/one', data: TREE, query: 'app' }))

    // Synchronously, on the first render: the point of the prefilter is that
    // the list is never empty while a round trip is in flight.
    expect(result.current.source).toBe('local')
    expect(result.current.hits.map(h => h.path)).toEqual(['/one/app.ts'])
  })

  it('replaces it with the ranked answer', async () => {
    store.searchFiles.mockResolvedValue([hit('/one/deep/never-expanded.ts', 'never-expanded.ts')])

    const { result } = renderHook(() => useFileSearch({ cwd: '/one', data: TREE, query: 'app' }))

    await waitFor(() => expect(result.current.source).toBe('server'))
    // A path from a folder that was never expanded — the whole reason the route
    // exists, and something the local scan structurally cannot produce.
    expect(result.current.hits.map(h => h.path)).toEqual(['/one/deep/never-expanded.ts'])
    expect(result.current.loading).toBe(false)
  })

  it('never asks for an empty query', async () => {
    renderHook(() => useFileSearch({ cwd: '/one', data: TREE, query: '   ' }))

    await new Promise(resolve => setTimeout(resolve, 120))

    expect(store.searchFiles).not.toHaveBeenCalled()
  })

  it('debounces a burst of keystrokes into one request', async () => {
    store.searchFiles.mockResolvedValue([])

    const { rerender } = renderHook(({ query }) => useFileSearch({ cwd: '/one', data: TREE, query }), {
      initialProps: { query: 'a' }
    })

    rerender({ query: 'ap' })
    rerender({ query: 'app' })

    await waitFor(() => expect(store.searchFiles).toHaveBeenCalledTimes(1))
    expect(store.searchFiles).toHaveBeenCalledWith('/one', 'app')
  })

  it('does not leak one workspace’s results into another', async () => {
    store.searchFiles.mockResolvedValue([hit('/one/found.ts', 'found.ts')])

    const { rerender, result } = renderHook(({ cwd }) => useFileSearch({ cwd, data: TREE, query: 'app' }), {
      initialProps: { cwd: '/one' }
    })

    await waitFor(() => expect(result.current.source).toBe('server'))

    // Switch workspace with the query still in the box. The answer on screen
    // belongs to the OLD tree, and the epoch is what makes it inadmissible
    // immediately — not once the new answer happens to land.
    store.searchFiles.mockImplementation(pending)
    rerender({ cwd: '/two' })

    expect(result.current.source).toBe('local')
    expect(result.current.hits.map(h => h.path)).not.toContain('/one/found.ts')
  })

  it('stops asking, and stays local, once the route is known missing', async () => {
    $fileSearchAvailable.set(false)

    const { result } = renderHook(() => useFileSearch({ cwd: '/one', data: TREE, query: 'app' }))

    await new Promise(resolve => setTimeout(resolve, 120))

    expect(store.searchFiles).not.toHaveBeenCalled()
    expect(result.current.available).toBe(false)
    expect(result.current.source).toBe('local')
    // Degraded, not gone: the old filter is still a real answer for the folders
    // the user has open.
    expect(result.current.hits.map(h => h.path)).toEqual(['/one/app.ts'])
  })
})
