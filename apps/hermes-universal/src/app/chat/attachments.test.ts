import { beforeEach, describe, expect, it, vi } from 'vitest'

import { selectRemotePaths } from '@/lib/desktop-fs'
import { ensureSession } from '@/store/chat'
import { requestGateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'

import {
  pickFolderAttachment,
  pickRemoteAttachment,
  pickRemoteFolderAttachment,
  stageAttachmentFromPath
} from './attachments'

const { openDialog, readFileBytes } = vi.hoisted(() => ({ openDialog: vi.fn(), readFileBytes: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openDialog }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: readFileBytes }))
vi.mock('@/store/chat', () => ({ ensureSession: vi.fn() }))
vi.mock('@/store/gateway', () => ({ requestGateway: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))
// Stale-runtime recovery reaches store/session -> lib/api -> store/connection,
// which subscribes to `$gatewayState` at import. Stub the seam: these cases are
// about ref shapes, and the wrapper has its own suite.
vi.mock('@/store/session-recovery', () => ({
  withSessionNotFoundResume: async (sessionId: string, _storedId: unknown, call: (id: string) => Promise<unknown>) => ({
    recovered: false,
    result: await call(sessionId),
    sessionId
  })
}))
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

// The reference grammar (agent/context_references.py, mirrored by
// components/assistant-ui/reference-kinds) falls back to `\S+` for an UNQUOTED
// value, so a path with a space is cut at the space: `@folder:/srv/my code`
// resolves `/srv/my` — a directory that plausibly exists — and leaves ` code`
// in the prompt as prose. Wrong folder, no error. Every ref we mint must quote
// the way the gateway's own `file.attach` already does.
describe('picked paths with spaces', () => {
  beforeEach(() => {
    vi.mocked(selectRemotePaths).mockReset().mockResolvedValue([])
    openDialog.mockReset()
  })

  it('quotes a backend file pick', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/srv/my code/main.ts'])

    await expect(pickRemoteAttachment()).resolves.toEqual({
      name: 'main.ts',
      ref: '@file:`/srv/my code/main.ts`'
    })
  })

  it('quotes a backend folder pick', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/srv/my code'])

    await expect(pickRemoteFolderAttachment()).resolves.toEqual({
      name: 'my code',
      ref: '@folder:`/srv/my code`'
    })
  })

  it('quotes a local folder pick', async () => {
    openDialog.mockResolvedValueOnce('/home/me/my code')

    await expect(pickFolderAttachment()).resolves.toEqual({
      name: 'my code',
      ref: '@folder:`/home/me/my code`'
    })
  })

  it('leaves a space-free path bare', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValueOnce(['/srv/work/main.ts'])

    await expect(pickRemoteAttachment()).resolves.toEqual({
      name: 'main.ts',
      ref: '@file:/srv/work/main.ts'
    })
  })
})

// Staging is the one attach path that can fail AFTER the user has committed to
// a file. It used to answer null for both "cancelled" and "failed", so an
// unreadable file or a gateway that staged nothing produced no chip and no
// message — the turn then went out as if nothing had been attached.
describe('staging failures are reported', () => {
  beforeEach(() => {
    vi.mocked(notifyError).mockReset()
    vi.mocked(ensureSession).mockResolvedValue({ id: 'live-1', storedId: 'stored-1' } as never)
    readFileBytes.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]))
    vi.mocked(requestGateway).mockReset()
  })

  it('raises a notification when the file cannot be read', async () => {
    readFileBytes.mockRejectedValueOnce(new Error('permission denied'))

    await expect(stageAttachmentFromPath('/work/secret.bin')).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('secret.bin'))
  })

  it('raises a notification when the gateway answers without a ref', async () => {
    vi.mocked(requestGateway).mockResolvedValue({} as never)

    await expect(stageAttachmentFromPath('/work/notes.txt')).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining('notes.txt'))
  })

  it('stays quiet when the gateway does hand back a ref', async () => {
    vi.mocked(requestGateway).mockResolvedValue({ ref_text: '@file:notes.txt' } as never)

    await expect(stageAttachmentFromPath('/work/notes.txt')).resolves.toEqual({
      name: 'notes.txt',
      ref: '@file:notes.txt'
    })
    expect(notifyError).not.toHaveBeenCalled()
  })
})
