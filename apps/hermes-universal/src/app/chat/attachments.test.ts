import { beforeEach, describe, expect, it, vi } from 'vitest'

import { selectRemotePaths } from '@/lib/desktop-fs'

import { pickRemoteAttachment, pickRemoteFolderAttachment } from './attachments'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }))
vi.mock('@/store/chat', () => ({ ensureSession: vi.fn() }))
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))
vi.mock('@/lib/desktop-fs', () => ({ selectRemotePaths: vi.fn(async () => []) }))

describe('remote attachment picks', () => {
  beforeEach(() => {
    vi.mocked(selectRemotePaths).mockReset().mockResolvedValue([])
  })

  it('stages a backend file pick as a raw @file: ref', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/work/repo/src/main.ts'])

    await expect(pickRemoteAttachment('/work/repo')).resolves.toEqual({
      name: 'main.ts',
      ref: '@file:/work/repo/src/main.ts'
    })
    expect(selectRemotePaths).toHaveBeenCalledWith({ defaultPath: '/work/repo' })
  })

  it('stages a backend folder pick as a raw @folder: ref', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/work/repo/docs'])

    await expect(pickRemoteFolderAttachment('/work/repo')).resolves.toEqual({
      name: 'docs',
      ref: '@folder:/work/repo/docs'
    })
    expect(selectRemotePaths).toHaveBeenCalledWith({ defaultPath: '/work/repo', directories: true })
  })

  it('returns null when the picker is cancelled', async () => {
    await expect(pickRemoteAttachment()).resolves.toBeNull()
    await expect(pickRemoteFolderAttachment()).resolves.toBeNull()
  })
})
