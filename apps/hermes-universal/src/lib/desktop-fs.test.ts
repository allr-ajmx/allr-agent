import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@/lib/platform'

// `vi.mock` is hoisted above every top-level binding, so the spy has to exist by
// the time the factory runs.
const { openDialog } = vi.hoisted(() => ({ openDialog: vi.fn(async () => '/local/picked') }))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openDialog }))

// The whole point of these cases is the desktop branch, so pretend we are one.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof Platform>()),
  IS_DESKTOP: true
}))

import { gatewayOwnsLocalFs, selectDesktopPaths, setDesktopFsRemotePicker } from '@/lib/desktop-fs'
import { $connection } from '@/store/connection'
import type { GatewayMode } from '@/store/gateway-config'

const selectPaths = vi.fn(async () => ['/backend/picked'])

const connectedOn = (mode?: GatewayMode) =>
  $connection.set({ authMode: 'none', baseUrl: 'https://gw.example', mode } as never)

beforeEach(() => {
  openDialog.mockClear()
  selectPaths.mockClear()
  setDesktopFsRemotePicker({ selectPaths })
})

afterEach(() => {
  setDesktopFsRemotePicker(null)
  $connection.set(null)
})

// A directory handed to `projects.create` is resolved by the GATEWAY — it is
// where the project lives, where its IDEA.md is written and where its sessions
// run. So the native OS dialog may only be used when this window and the
// gateway share a filesystem; anywhere else it names a path on the wrong host,
// and `/home/me/work` existing on both machines makes that silent.
describe('selectDesktopPaths — directory picks', () => {
  it('uses the native dialog only when the desktop spawned the gateway itself', () => {
    connectedOn('local')
    expect(gatewayOwnsLocalFs()).toBe(true)
  })

  it('browses the backend for every gateway that owns another filesystem', async () => {
    for (const mode of ['remote', 'cloud', 'ssh'] as GatewayMode[]) {
      connectedOn(mode)
      expect(gatewayOwnsLocalFs()).toBe(false)

      await expect(selectDesktopPaths({ directories: true })).resolves.toEqual(['/backend/picked'])
    }

    expect(openDialog).not.toHaveBeenCalled()
    expect(selectPaths).toHaveBeenCalledTimes(3)
  })

  it('treats a connection with no declared mode as remote', async () => {
    connectedOn(undefined)

    await expect(selectDesktopPaths({ directories: true })).resolves.toEqual(['/backend/picked'])
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('opens the OS dialog on a local gateway', async () => {
    connectedOn('local')

    await expect(selectDesktopPaths({ defaultPath: '/home/me', directories: true })).resolves.toEqual(['/local/picked'])
    expect(openDialog).toHaveBeenCalledWith({ defaultPath: '/home/me', directory: true, multiple: false })
    expect(selectPaths).not.toHaveBeenCalled()
  })

  it('still routes FILE picks to the backend, even on a local gateway', async () => {
    connectedOn('local')

    await expect(selectDesktopPaths({ directories: false })).resolves.toEqual(['/backend/picked'])
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('answers empty — the same as cancelled — when nothing can pick', async () => {
    connectedOn('remote')
    setDesktopFsRemotePicker(null)

    await expect(selectDesktopPaths({ directories: true })).resolves.toEqual([])
  })
})
