import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DesktopFsModule from '@/lib/desktop-fs'
import type * as GatewayModule from '@/store/gateway'
import type * as NotificationsModule from '@/store/notifications'

const { notifyError, requestGateway, writeDesktopFileText } = vi.hoisted(() => ({
  notifyError: vi.fn(),
  requestGateway: vi.fn(),
  writeDesktopFileText: vi.fn()
}))

// Partial mocks throughout: store/connection subscribes to `$gatewayState` at
// import time, and store/projects pulls several other helpers out of each of
// these modules — the real ones have to stay underneath.
vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGateway
}))

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...(await importOriginal<typeof DesktopFsModule>()),
  writeDesktopFileText
}))

vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notifyError
}))

import type { ProjectInfo } from '@/types/hermes'

import { $activeProjectId, $projects, $projectsRpcAvailable, $projectTree, createProject } from './projects'

const project = (patch: Partial<ProjectInfo> = {}): ProjectInfo => ({
  archived: false,
  board_slug: null,
  color: null,
  created_at: 0,
  description: null,
  folders: [],
  icon: null,
  id: 'p_idea',
  name: 'Idea',
  primary_path: '/www/idea',
  slug: 'idea',
  ...patch
})

// `projects.create` answers with the row; every other call in the flow is the
// background reconcile, which this shape satisfies harmlessly.
const createReturns = (created: ProjectInfo) => {
  requestGateway.mockImplementation(async (method: string) =>
    method === 'projects.create' ? { project: created } : {}
  )
}

beforeEach(() => {
  requestGateway.mockReset()
  writeDesktopFileText.mockReset()
  writeDesktopFileText.mockResolvedValue({ path: '' })
  notifyError.mockReset()
  $projects.set([])
  $projectTree.set([])
  $activeProjectId.set(null)
  $projectsRpcAvailable.set(true)
})

describe('createProject → IDEA.md', () => {
  it('writes the idea into the primary folder with a single trailing newline', async () => {
    createReturns(project())

    await createProject({ folders: ['/www/idea'], idea: '  A tool for tools  ', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledTimes(1)
    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'A tool for tools\n')
  })

  it('does not double the newline on an idea that already ends in one', async () => {
    createReturns(project())

    await createProject({ folders: ['/www/idea'], idea: 'Ends in a newline\n', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'Ends in a newline\n')
  })

  it('writes nothing when there is no idea, or only whitespace', async () => {
    createReturns(project())

    await createProject({ folders: ['/www/idea'], name: 'Idea' })
    await createProject({ folders: ['/www/idea'], idea: '   ', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
  })

  it('falls back to the first folder, then to the requested primary path', async () => {
    createReturns(
      project({ folders: [{ added_at: 0, is_primary: true, label: null, path: '/www/first' }], primary_path: null })
    )
    await createProject({ folders: ['/www/first'], idea: 'From folders', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/first/IDEA.md', 'From folders\n')

    createReturns(project({ primary_path: null }))
    await createProject({ idea: 'From input', name: 'Idea', primaryPath: '/www/input' })

    expect(writeDesktopFileText).toHaveBeenLastCalledWith('/www/input/IDEA.md', 'From input\n')
  })

  it('does not double the separator on a folder with a trailing slash', async () => {
    createReturns(project({ primary_path: '/www/idea/' }))

    await createProject({ folders: ['/www/idea/'], idea: 'Trailing slash', name: 'Idea' })

    expect(writeDesktopFileText).toHaveBeenCalledWith('/www/idea/IDEA.md', 'Trailing slash\n')
  })

  it('writes nothing when the backend reports no folder at all', async () => {
    createReturns(project({ primary_path: null }))

    await createProject({ idea: 'Nowhere to put it', name: 'Idea' })

    expect(writeDesktopFileText).not.toHaveBeenCalled()
  })

  it('still creates the project when the write fails, and says so', async () => {
    createReturns(project())
    const err = new Error('read-only file system')
    writeDesktopFileText.mockRejectedValue(err)

    await expect(createProject({ folders: ['/www/idea'], idea: 'Doomed', name: 'Idea' })).resolves.toMatchObject({
      id: 'p_idea'
    })

    expect(notifyError).toHaveBeenCalledWith(err, 'Project created, but IDEA.md could not be saved')
  })
})
