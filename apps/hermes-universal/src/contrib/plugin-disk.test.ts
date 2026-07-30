/**
 * Door selection and the two implementations. The invariant worth protecting is
 * #66899: the LOCAL door must resolve from this device, never from the connected
 * backend's `hermes_home` — so `plugins_root`/`plugins_list`/`plugins_read` are
 * the only things it may call, and it must never reach for `getStatus()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const getStatus = vi.hoisted(() => vi.fn())
const readDesktopDir = vi.hoisted(() => vi.fn())
const readDesktopFileText = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ IS_DESKTOP: true }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
// The store graph reached through $connection / $activeProfile also pulls a few
// @/hermes exports at module scope; stub them so the mock is complete.
vi.mock('@/hermes', () => ({ getStatus, setApiRequestProfile: vi.fn() }))
vi.mock('@/lib/desktop-fs', () => ({ readDesktopDir, readDesktopFileText }))
vi.mock('@/lib/reveal-path', () => ({ revealPathInFileManager: vi.fn() }))
vi.mock('@/lib/platform', () => platform)

import { $restDoorEnabled, LOCAL_POLL_MS, resolvePluginDisk, REST_POLL_MS } from './plugin-disk'

const rustEntry = (name: string, mtime = 100, size = 10) => ({
  file: `/home/u/.hermes/desktop-plugins/${name}/plugin.js`,
  mtime_ms: mtime,
  name,
  size
})

beforeEach(() => {
  platform.IS_DESKTOP = true
  $restDoorEnabled.set(true)
  localStorage.clear()

  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'plugins_root') {return Promise.resolve('/home/u/.hermes/desktop-plugins')}

    if (cmd === 'plugins_list') {return Promise.resolve([])}

    if (cmd === 'plugins_read') {return Promise.resolve('export default {}')}

    return Promise.reject(new Error(`unexpected command ${cmd}`))
  })

  getStatus.mockResolvedValue({ hermes_home: '/srv/hermes' })
  readDesktopDir.mockResolvedValue({ entries: [] })
  readDesktopFileText.mockResolvedValue({ path: '', text: 'export default {}' })
})

afterEach(() => vi.clearAllMocks())

describe('door selection', () => {
  it('prefers the local door when it has plugins', async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === 'plugins_list' ? Promise.resolve([rustEntry('kanban')]) : Promise.resolve('/root')
    )

    const disk = await resolvePluginDisk()

    expect(disk?.kind).toBe('local')
    // #66899: the local door must never consult the backend for its root.
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('falls through to the gateway door when the local root is empty', async () => {
    expect((await resolvePluginDisk())?.kind).toBe('rest')
  })

  it('falls through when the local door errors outright', async () => {
    invoke.mockRejectedValue(new Error('no HERMES_HOME'))

    expect((await resolvePluginDisk())?.kind).toBe('rest')
  })

  it('keeps the local door when the gateway door is switched off, so Rescan still has a root', async () => {
    $restDoorEnabled.set(false)

    expect((await resolvePluginDisk())?.kind).toBe('local')
  })

  // A phone has no local root at all; the gateway door is the only one.
  it('uses the gateway door on mobile', async () => {
    platform.IS_DESKTOP = false

    expect((await resolvePluginDisk())?.kind).toBe('rest')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('has no door on mobile with the gateway door switched off', async () => {
    platform.IS_DESKTOP = false
    $restDoorEnabled.set(false)

    expect(await resolvePluginDisk()).toBeNull()
  })

  it('defaults the gateway door ON — plugins reach a phone with no setup', () => {
    expect($restDoorEnabled.get()).toBe(true)
  })
})

describe('local door', () => {
  const localDoor = async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'plugins_root') {return Promise.resolve('/home/u/.hermes/desktop-plugins')}

      if (cmd === 'plugins_list') {return Promise.resolve([rustEntry('kanban')])}

      return Promise.resolve('export default { id: "kanban" }')
    })

    const disk = await resolvePluginDisk()
    invoke.mockClear()

    return disk!
  }

  it('stamps entries with mtime:size so a poll needs no file read', async () => {
    const [entry] = await (await localDoor()).list()

    expect(entry).toEqual({
      file: '/home/u/.hermes/desktop-plugins/kanban/plugin.js',
      name: 'kanban',
      stamp: '100:10'
    })
  })

  it('reads by folder NAME, never by path — the address space the Rust side enforces', async () => {
    const disk = await localDoor()
    const [entry] = await disk.list()

    await disk.read(entry)

    expect(invoke).toHaveBeenCalledWith('plugins_read', { name: 'kanban', profile: null })
  })

  it('compares stamps rather than hashing, and polls fast', async () => {
    const disk = await localDoor()

    expect(disk.hashToDetectChange).toBe(false)
    expect(disk.pollMs).toBe(LOCAL_POLL_MS)
  })

  it('offers reveal — the path is on this machine', async () => {
    expect((await localDoor()).reveal).toBeTypeOf('function')
  })
})

describe('gateway door', () => {
  const restDoor = async () => (await resolvePluginDisk())!

  it('roots at the backend-reported hermes_home', async () => {
    expect(await (await restDoor()).root()).toBe('/srv/hermes/desktop-plugins')
  })

  it('reports unavailable when the backend omits hermes_home', async () => {
    getStatus.mockResolvedValue({})

    await expect((await restDoor()).root()).rejects.toThrow(/did not report its hermes_home/)
  })

  it('lists only directories that carry a readable plugin.js', async () => {
    readDesktopDir.mockResolvedValue({
      entries: [
        { isDirectory: true, name: 'kanban', path: '/srv/hermes/desktop-plugins/kanban' },
        { isDirectory: true, name: 'broken', path: '/srv/hermes/desktop-plugins/broken' },
        { isDirectory: true, name: '.git', path: '/srv/hermes/desktop-plugins/.git' },
        { isDirectory: false, name: 'README.md', path: '/srv/hermes/desktop-plugins/README.md' }
      ]
    })
    readDesktopFileText.mockImplementation((path: string) =>
      path.includes('broken') ? Promise.reject(new Error('ENOENT')) : Promise.resolve({ path, text: 'src' })
    )

    expect((await (await restDoor()).list()).map(e => e.name)).toEqual(['kanban'])
  })

  it('treats a missing root as no plugins, not an error', async () => {
    readDesktopDir.mockResolvedValue({ entries: [], error: 'ENOENT' })

    expect(await (await restDoor()).list()).toEqual([])
  })

  it('has no stamp, so the loader must hash — and polls slower for it', async () => {
    readDesktopDir.mockResolvedValue({
      entries: [{ isDirectory: true, name: 'kanban', path: '/srv/hermes/desktop-plugins/kanban' }]
    })

    const disk = await restDoor()

    expect((await disk.list())[0].stamp).toBe('')
    expect(disk.hashToDetectChange).toBe(true)
    expect(disk.pollMs).toBe(REST_POLL_MS)
    expect(disk.pollMs).toBeGreaterThan(LOCAL_POLL_MS)
  })

  it('offers no reveal — a gateway path means nothing to this device', async () => {
    expect((await restDoor()).reveal).toBeUndefined()
  })

  // Resolution itself probes the local root on desktop (that is how it decides to
  // fall through), so clear after resolving: the assertion is about the DOOR.
  it('never touches the Rust commands once selected', async () => {
    const disk = await restDoor()
    invoke.mockClear()

    await disk.root()
    await disk.list()

    expect(invoke).not.toHaveBeenCalled()
  })
})
