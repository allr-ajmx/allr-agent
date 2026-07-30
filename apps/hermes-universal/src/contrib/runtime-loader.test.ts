/**
 * The loader pipeline (specifier rewrite, unsupported imports, SRI) and the disk
 * reconciliation loop driven by a fake `PluginDisk` — so the whole write→reload
 * behaviour is covered without Tauri or a gateway.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

import type { DiskEntry, PluginDisk } from './plugin-disk'
import { $pluginDecisions, $pluginRecords } from './plugins-store'
import { registry } from './registry'
import {
  __resetRuntimeLoaderForTests,
  loadRuntimePlugin,
  scanDiskPlugins,
  unloadRuntimePlugin
} from './runtime-loader'

// jsdom can't `import()` a blob URL, so route the loader's blob back to a module
// this test controls. Keyed by the generated URL so parallel loads don't collide.
const modules = new Map<string, { default?: unknown }>()
let nextUrl = 0

beforeEach(() => {
  modules.clear()
  $pluginRecords.set({})
  $pluginDecisions.set({})
  __resetRuntimeLoaderForTests()

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const url = `blob:plugin/${nextUrl++}`
      // The loader passes the REWRITTEN source; keep it so tests can assert on it.
      modules.set(url, { default: undefined })
      void (blob as Blob & { __source?: string })

      return url
    },
    revokeObjectURL: () => {}
  })
})

afterEach(() => {
  __resetRuntimeLoaderForTests()
  vi.clearAllMocks()
})

// The real loader `import()`s the blob. Rather than fight jsdom, drive the disk
// half through a door whose sources are plugins we can express as ESM text, and
// assert the pipeline half on its observable output: the error records.
const rejectedError = (origin: string) => $pluginRecords.get()[origin]?.error ?? ''

describe('import specifier handling', () => {
  it('rejects a bare import the loader cannot resolve, naming it', async () => {
    await loadRuntimePlugin(`import x from 'lodash'\nexport default { id: 'a', register() {} }`, 'a')

    expect(rejectedError('a')).toContain('unsupported import')
    expect(rejectedError('a')).toContain('lodash')
  })

  it('lists every unresolvable specifier, not just the first', async () => {
    await loadRuntimePlugin(`import a from 'lodash'\nimport b from 'dayjs'\n`, 'multi')

    expect(rejectedError('multi')).toContain('lodash')
    expect(rejectedError('multi')).toContain('dayjs')
  })

  it('allows the SDK and react — the two specifiers the shims cover', async () => {
    await loadRuntimePlugin(
      `import { host } from '@hermes/plugin-sdk'\nimport React from 'react'\nimport { jsx } from 'react/jsx-runtime'\n`,
      'ok'
    )

    expect(rejectedError('ok')).not.toContain('unsupported import')
  })

  it('allows relative and URL specifiers', async () => {
    await loadRuntimePlugin(`import a from './util.js'\nimport b from 'https://x/y.js'\n`, 'rel')

    expect(rejectedError('rel')).not.toContain('unsupported import')
  })

  // The rewrite is anchored to import/export syntax, so a plugin mentioning
  // 'react' or 'lodash' in a plain string is untouched — that's the case that
  // matters, since rewriting a string would corrupt the plugin's own data.
  it('ignores specifier-looking string literals', async () => {
    await loadRuntimePlugin(
      `const label = 'lodash'\nhost.notify('react')\nexport default { id: 'strings', register() {} }`,
      'strings'
    )

    expect(rejectedError('strings')).not.toContain('unsupported import')
  })

  // Known limitation, shared with desktop: a regex can't tell a commented-out
  // import from a real one. Failing CLOSED is the right way round — the plugin
  // gets a named error instead of a silently-ignored dependency — but the message
  // will confuse someone who left dead code in their file.
  it('still flags a commented-out import (regex, not a parser)', async () => {
    await loadRuntimePlugin(`// import x from 'lodash'\nexport default { id: 'c', register() {} }`, 'commented')

    expect(rejectedError('commented')).toContain('lodash')
  })
})

describe('integrity', () => {
  const source = `export default { id: 'x', register() {} }`

  it('rejects a mismatched hash before evaluating anything', async () => {
    await loadRuntimePlugin(source, 'bad-sri', { integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })

    expect(rejectedError('bad-sri')).toContain('integrity check failed')
  })

  it('rejects an unsupported algorithm rather than skipping the check', async () => {
    await loadRuntimePlugin(source, 'md5', { integrity: 'md5-abc' })

    expect(rejectedError('md5')).toContain('integrity check failed')
  })

  it('rejects a malformed integrity value', async () => {
    await loadRuntimePlugin(source, 'garbage', { integrity: 'sha256-' })

    expect(rejectedError('garbage')).toContain('integrity check failed')
  })
})

describe('failure handling', () => {
  it('records an error row instead of throwing, so one bad plugin is contained', async () => {
    await expect(loadRuntimePlugin(`import x from 'lodash'`, 'contained')).resolves.toBeNull()

    expect($pluginRecords.get().contained).toMatchObject({ kind: 'disk', status: 'error' })
  })

  it('keys the error row on the origin, so the settings page can name the folder', async () => {
    await loadRuntimePlugin(`import x from 'lodash'`, 'my-folder', { file: '/root/my-folder/plugin.js' })

    expect($pluginRecords.get()['my-folder'].file).toBe('/root/my-folder/plugin.js')
  })
})

describe('unloadRuntimePlugin', () => {
  it('is a no-op for an unknown id', () => {
    expect(() => unloadRuntimePlugin('never-loaded')).not.toThrow()
  })
})

// ── disk reconciliation ─────────────────────────────────────────────────────
// A fake door + a loadRuntimePlugin stub: what matters here is WHICH entries the
// scanner decides to (re)load and which records it drops, not the evaluation.

interface FakeFile {
  source: string
  stamp: string
}

function fakeDoor(files: Map<string, FakeFile>, over: Partial<PluginDisk> = {}): PluginDisk {
  return {
    kind: 'local',
    hashToDetectChange: false,
    pollMs: 1_000,
    root: async () => '/root',
    list: async () =>
      [...files.entries()].map(([name, file]) => ({
        file: `/root/${name}/plugin.js`,
        name,
        stamp: file.stamp
      })),
    read: async (entry: DiskEntry) => {
      const file = files.get(entry.name)

      if (!file) {
        throw new Error('ENOENT')
      }

      return file.source
    },
    ...over
  }
}

/** A plugin whose registration we can observe through the registry. */
const pluginSource = (id: string) =>
  `export default { id: '${id}', register(ctx) { ctx.register({ area: 'panes', id: 'p', render: () => null }) } }`

describe('disk reconciliation', () => {
  it('reads each newly discovered folder exactly once', async () => {
    const files = new Map([['kanban', { source: pluginSource('kanban'), stamp: '1:1' }]])
    const door = fakeDoor(files)
    const read = vi.spyOn(door, 'read')

    await scanDiskPlugins(door)

    expect(read).toHaveBeenCalledOnce()
  })

  it('does not re-read an unchanged folder on the next tick', async () => {
    const files = new Map([['kanban', { source: pluginSource('kanban'), stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)
    const read = vi.spyOn(door, 'read')
    await scanDiskPlugins(door)

    expect(read).not.toHaveBeenCalled()
  })

  it('re-reads exactly once when the stamp changes', async () => {
    const files = new Map([['kanban', { source: pluginSource('kanban'), stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)

    files.set('kanban', { source: pluginSource('kanban'), stamp: '2:2' })
    const read = vi.spyOn(door, 'read')

    await scanDiskPlugins(door)
    expect(read).toHaveBeenCalledOnce()

    // …and stays quiet once the new stamp is recorded.
    read.mockClear()
    await scanDiskPlugins(door)
    expect(read).not.toHaveBeenCalled()
  })

  it('drops the inventory row when a folder vanishes', async () => {
    const files = new Map([['gone', { source: `import x from 'lodash'`, stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)
    expect($pluginRecords.get().gone).toBeTruthy()

    files.delete('gone')
    await scanDiskPlugins(door)

    expect($pluginRecords.get().gone).toBeUndefined()
  })

  it('re-reads a folder that reappears after being deleted', async () => {
    const files = new Map([['flap', { source: `import x from 'lodash'`, stamp: '1:1' }]])
    const door = fakeDoor(files)

    await scanDiskPlugins(door)
    files.delete('flap')
    await scanDiskPlugins(door)

    files.set('flap', { source: `import x from 'lodash'`, stamp: '1:1' })
    const read = vi.spyOn(door, 'read')
    await scanDiskPlugins(door)

    expect(read).toHaveBeenCalledOnce()
  })

  it('does nothing at all when there is no door', async () => {
    await expect(scanDiskPlugins(undefined)).resolves.toBeUndefined()
  })

  it('survives a door whose list() throws', async () => {
    const door = fakeDoor(new Map(), { list: async () => Promise.reject(new Error('offline')) })

    await expect(scanDiskPlugins(door)).resolves.toBeUndefined()
  })

  it('skips a folder whose read fails, leaving the rest to load', async () => {
    const files = new Map([
      ['ok', { source: `import x from 'lodash'`, stamp: '1:1' }],
      ['unreadable', { source: '', stamp: '1:1' }]
    ])

    const door = fakeDoor(files, {
      read: async (entry: DiskEntry) => {
        if (entry.name === 'unreadable') {
          throw new Error('EACCES')
        }

        return files.get(entry.name)!.source
      }
    })

    await scanDiskPlugins(door)

    expect($pluginRecords.get().ok).toBeTruthy()
    expect($pluginRecords.get().unreadable).toBeUndefined()
  })

  describe('a door with no stamp (the gateway door)', () => {
    const hashingDoor = (files: Map<string, FakeFile>) =>
      fakeDoor(files, { hashToDetectChange: true, kind: 'rest' })

    it('hashes source to spot an edit the stamp cannot show', async () => {
      const files = new Map([['kanban', { source: `import a from 'lodash'`, stamp: '' }]])
      const door = hashingDoor(files)

      await scanDiskPlugins(door)

      // Same stamp ('') but different bytes — only a hash catches this.
      files.set('kanban', { source: `import b from 'dayjs'`, stamp: '' })
      await scanDiskPlugins(door)

      expect($pluginRecords.get().kanban.error).toContain('dayjs')
    })

    it('does not reload when the source is byte-identical', async () => {
      const files = new Map([['kanban', { source: `import a from 'lodash'`, stamp: '' }]])
      const door = hashingDoor(files)

      await scanDiskPlugins(door)
      await scanDiskPlugins(door)

      const read = vi.spyOn(door, 'read')
      await scanDiskPlugins(door)

      // One read to hash, and no reload read on top of it.
      expect(read).toHaveBeenCalledOnce()
    })

    it('reconciles membership only past the folder cap', async () => {
      const files = new Map<string, FakeFile>(
        Array.from({ length: 30 }, (_, i) => [`p${i}`, { source: `import x from 'lodash'`, stamp: '' }])
      )

      const door = hashingDoor(files)

      await scanDiskPlugins(door)

      const read = vi.spyOn(door, 'read')
      await scanDiskPlugins(door)

      // No content hashing at this size — an in-place edit needs manual Rescan.
      expect(read).not.toHaveBeenCalled()

      // But a NEW folder still lands.
      files.set('late', { source: `import x from 'lodash'`, stamp: '' })
      await scanDiskPlugins(door)
      expect($pluginRecords.get().late).toBeTruthy()
    })
  })

  afterEach(() => {
    for (const c of registry.getArea('panes')) {
      if (c.source?.startsWith('plugin:')) {
        registry.register({ ...c, enabled: false })
      }
    }
  })
})
