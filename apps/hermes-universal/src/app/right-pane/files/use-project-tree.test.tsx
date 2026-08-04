import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  readProjectDir: vi.fn(),
  clearProjectDirCache: vi.fn()
}))

vi.mock('./ipc', () => ipc)
vi.mock('@/store/connection', async () => {
  const { atom } = await import('@/store/atom')

  return { $connection: atom({ mode: 'local' }) }
})
vi.mock('@/store/gateway-config', () => ({ connectionCacheKey: () => 'test-connection' }))

import { resetProjectTreeState, useProjectTree } from './use-project-tree'

// A readDir that never settles: the point of these tests is what the pane shows
// WHILE the new root is loading, which is the window the header used to spend
// naming the previous directory.
const pending = () => new Promise<never>(() => {})

beforeEach(() => {
  resetProjectTreeState()
  ipc.readProjectDir.mockReset()
  ipc.clearProjectDirCache.mockReset()
})

describe('useProjectTree root switching', () => {
  it('names the requested root while its readDir is still in flight', async () => {
    ipc.readProjectDir.mockResolvedValue({ entries: [{ path: '/repo/a', name: 'a', isDirectory: false }] })

    const { rerender, result } = renderHook(({ cwd }) => useProjectTree(cwd), {
      initialProps: { cwd: '/repo' }
    })

    await waitFor(() => expect(result.current.rootLoading).toBe(false))
    expect(result.current.effectiveCwd).toBe('/repo')

    // Switch to a just-created worktree whose read hasn't come back yet.
    ipc.readProjectDir.mockImplementation(pending)
    rerender({ cwd: '/repo/.worktrees/feature-a' })

    await waitFor(() => expect(result.current.rootLoading).toBe(true))

    // The header reads `effectiveCwd`. Carrying the previous resolvedCwd through
    // the load made it keep naming '/repo' for the whole read — the "flips to the
    // old directory until the first message settles it" symptom.
    expect(result.current.effectiveCwd).toBe('/repo/.worktrees/feature-a')
  })

  it('still reports a real fallback root once one is resolved', async () => {
    ipc.readProjectDir.mockResolvedValue({ entries: [] })

    const { result } = renderHook(() => useProjectTree('/repo'))

    await waitFor(() => expect(result.current.rootLoading).toBe(false))
    expect(result.current.effectiveCwd).toBe('/repo')
    expect(result.current.rootError).toBeNull()
  })
})
