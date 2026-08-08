import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GatewayModule from '@/store/gateway'

const { requestGateway } = vi.hoisted(() => ({ requestGateway: vi.fn() }))

// Partial mock: store/connection subscribes to `$gatewayState` at import time,
// so the real module has to stay underneath.
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGateway
}))

import type { SidebarProjectTree } from '@/app/chat/sidebar/projects/model'

import { $projects, $projectsRpcAvailable, $projectTree, setProjectAppearance } from './projects'

const node = (patch: Partial<SidebarProjectTree> = {}): SidebarProjectTree => ({
  id: 'p_app',
  label: 'App',
  path: '/www/app',
  repos: [],
  sessionCount: 0,
  ...patch
})

beforeEach(() => {
  requestGateway.mockReset()
  requestGateway.mockResolvedValue({} as never)
  $projects.set([])
  $projectTree.set([])
  $projectsRpcAvailable.set(true)
})

describe('setProjectAppearance', () => {
  it('patches a real project in place and does not materialize', async () => {
    $projectTree.set([node({ color: '#111111' })])

    await expect(setProjectAppearance(node({ color: '#111111' }), { color: '#4a9eff' })).resolves.toBe(false)

    expect(requestGateway).toHaveBeenCalledWith('projects.update', { id: 'p_app', color: '#4a9eff' })
    expect($projectTree.get()[0].color).toBe('#4a9eff')
  })

  it('clears a color with the empty string the backend reads as "clear"', async () => {
    $projectTree.set([node({ color: '#4a9eff' })])

    await setProjectAppearance(node({ color: '#4a9eff' }), { color: null })

    expect(requestGateway).toHaveBeenCalledWith('projects.update', { id: 'p_app', color: '' })
  })

  // An inherited (auto) project is a git repo root with no projects.db row, so
  // there is no id to PATCH — theming it has to create the row.
  it('materializes an inherited project into a real one', async () => {
    requestGateway.mockResolvedValue({
      project: { id: 'p_new', name: 'App', color: '#4a9eff', folders: [] }
    } as never)

    await expect(setProjectAppearance(node({ id: '/www/app', isAuto: true }), { color: '#4a9eff' })).resolves.toBe(true)

    expect(requestGateway).toHaveBeenCalledWith(
      'projects.create',
      expect.objectContaining({ name: 'App', folders: ['/www/app'], primary_path: '/www/app', color: '#4a9eff' })
    )
  })

  it('carries the already-set field so setting one does not wipe the other', async () => {
    requestGateway.mockResolvedValue({ project: null } as never)

    await setProjectAppearance(node({ id: '/www/app', color: '#4a9eff', isAuto: true }), { icon: 'rocket' })

    expect(requestGateway).toHaveBeenCalledWith(
      'projects.create',
      expect.objectContaining({ color: '#4a9eff', icon: 'rocket' })
    )
  })

  it('does nothing for an inherited project with no path to anchor to', async () => {
    await expect(setProjectAppearance(node({ id: 'auto', isAuto: true, path: null }), { color: '#fff' })).resolves.toBe(
      false
    )

    expect(requestGateway).not.toHaveBeenCalled()
  })
})
