import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/gateway-rest', () => ({
  exportProfileArchive: vi.fn(),
  importProfileArchive: vi.fn()
}))
vi.mock('@/lib/desktop-fs', () => ({ selectRemotePaths: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/profiles', async importActual => {
  const actual = await importActual<Record<string, unknown>>()

  return { ...actual, refreshProfiles: vi.fn().mockResolvedValue(undefined), setActiveProfile: vi.fn() }
})

import { $layoutTree } from '@/components/pane-shell/tree/store'
import { selectRemotePaths } from '@/lib/desktop-fs'
import { exportProfileArchive, importProfileArchive, type ProfileDesktopOverlay } from '@/lib/gateway-rest'
import { $mode, $skin } from '@/themes/context'
import { $userThemes, resolveTheme } from '@/themes/user-themes'

import { notify, notifyError } from './notifications'
import { $profileColors, setProfileColor } from './profile'
import {
  applyDesktopOverlay,
  buildDesktopOverlay,
  DESKTOP_OVERLAY_FILENAME,
  exportProfileBundle,
  importProfileBundle,
  runExportProfileFlow,
  runImportProfileFlow
} from './profile-share'

const mockExport = vi.mocked(exportProfileArchive)
const mockImport = vi.mocked(importProfileArchive)

// A minimal but complete user theme, so installUserTheme accepts it and the
// round-trip has something non-built-in to carry.
const userTheme = {
  name: 'ocean',
  label: 'Ocean',
  description: 'A bundled theme',
  colors: { background: '#001018', foreground: '#e6f2ff', primary: '#3aa0ff' }
}

const tree = { id: 'root', type: 'group' as const, panes: ['chat'], active: 'chat' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  $skin.set('nous')
  $mode.set('system')
  $userThemes.set({})
  $profileColors.set({})
  $layoutTree.set(null)
  mockExport.mockResolvedValue({ ok: true, archive: '/home/h/.hermes/profile-exports/work.tar.gz' })
})

describe('buildDesktopOverlay', () => {
  it('snapshots the appearance the receiver needs to reproduce the look', () => {
    $skin.set('nous')
    $mode.set('dark')
    setProfileColor('work', '#ff8800')

    const overlay = buildDesktopOverlay('work')

    expect(overlay).toMatchObject({ version: 1, skin: 'nous', mode: 'dark', profileColor: '#ff8800' })
  })

  it('bundles the full definition of a non-built-in skin, and nothing for a built-in', () => {
    $userThemes.set({ ocean: userTheme as never })
    $skin.set('ocean')

    expect(buildDesktopOverlay('work').themes).toEqual({ ocean: userTheme })

    $skin.set('nous')
    expect(buildDesktopOverlay('work').themes).toBeUndefined()
  })

  it('normalizes the profile key, so `default` and empty agree', () => {
    setProfileColor('default', '#123456')

    expect(buildDesktopOverlay('').profileColor).toBe('#123456')
  })
})

describe('export → import round trip', () => {
  it('stages the overlay into the archive under the agreed filename', async () => {
    $skin.set('nous')
    $mode.set('light')
    setProfileColor('work', '#00ccaa')

    const archive = await exportProfileBundle('work')

    expect(archive).toBe('/home/h/.hermes/profile-exports/work.tar.gz')
    const [name, opts] = mockExport.mock.calls[0]
    expect(name).toBe('work')
    const staged = JSON.parse(opts?.extraFiles?.[DESKTOP_OVERLAY_FILENAME] ?? '{}')
    expect(staged).toMatchObject({ version: 1, skin: 'nous', mode: 'light', profileColor: '#00ccaa' })
  })

  it('restores skin, mode, bundled theme and rail color on the receiving side', async () => {
    // Sender.
    $userThemes.set({ ocean: userTheme as never })
    $skin.set('ocean')
    $mode.set('dark')
    setProfileColor('work', '#ff0066')
    await exportProfileBundle('work')

    const overlay = JSON.parse(
      mockExport.mock.calls[0][1]?.extraFiles?.[DESKTOP_OVERLAY_FILENAME] ?? '{}'
    ) as ProfileDesktopOverlay

    // Receiver: a clean machine that has never seen this theme.
    $userThemes.set({})
    $skin.set('nous')
    $mode.set('system')
    $profileColors.set({})
    mockImport.mockResolvedValue({ ok: true, name: 'work', path: '/p/work', desktop: overlay })

    const name = await importProfileBundle('/tmp/work.tar.gz')

    expect(name).toBe('work')
    expect(resolveTheme('ocean')?.label).toBe('Ocean')
    expect($skin.get()).toBe('ocean')
    expect($mode.get()).toBe('dark')
    expect($profileColors.get().work).toBe('#ff0066')
  })

  it('adopts a bundled layout tree', async () => {
    mockImport.mockResolvedValue({
      ok: true,
      name: 'work',
      path: '/p/work',
      desktop: { version: 1, layoutTree: tree }
    })

    await importProfileBundle('/tmp/work.tar.gz')

    expect($layoutTree.get()).toMatchObject({ type: 'group', panes: ['chat'] })
  })
})

describe('applyDesktopOverlay — hostile input', () => {
  it('is a no-op for an archive that carried no overlay (a plain CLI export)', () => {
    applyDesktopOverlay('work', null)
    applyDesktopOverlay('work', undefined)

    expect($skin.get()).toBe('nous')
    expect($mode.get()).toBe('system')
  })

  it('refuses a skin that resolves to nothing rather than pointing the pref at air', () => {
    applyDesktopOverlay('work', { version: 1, skin: 'not-a-theme-anyone-has' })

    expect($skin.get()).toBe('nous')
  })

  it('refuses a mode that is not one of the three', () => {
    applyDesktopOverlay('work', { version: 1, mode: 'chartreuse' })

    expect($mode.get()).toBe('system')
  })

  it('keeps the current layout when the bundled tree is junk', () => {
    $layoutTree.set(null)
    applyDesktopOverlay('work', { version: 1, layoutTree: { nope: true } })

    expect($layoutTree.get()).toBeNull()
  })

  it('applies the good half of a half-malformed overlay', () => {
    applyDesktopOverlay('work', {
      version: 1,
      mode: 'dark',
      skin: 'not-a-theme',
      themes: { junk: { name: 42 } as never },
      profileColor: '#abcdef'
    })

    expect($mode.get()).toBe('dark')
    expect($skin.get()).toBe('nous')
    expect($profileColors.get().work).toBe('#abcdef')
  })
})

describe('flows', () => {
  it('export reports the BACKEND path it landed on', async () => {
    const archive = await runExportProfileFlow('work')

    expect(archive).toBe('/home/h/.hermes/profile-exports/work.tar.gz')
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', message: '/home/h/.hermes/profile-exports/work.tar.gz' })
    )
    // No `output` — the backend names the file, because on a remote gateway the
    // archive is written on that machine.
    expect(mockExport.mock.calls[0][1]?.output).toBeUndefined()
  })

  it('export surfaces a failure instead of throwing at the caller', async () => {
    mockExport.mockRejectedValue(new Error('no such profile'))

    await expect(runExportProfileFlow('gone')).resolves.toBeNull()
    expect(notifyError).toHaveBeenCalled()
  })

  it('import picks on the BACKEND filesystem, not through a native dialog', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValue(['/srv/hermes/work.tar.gz'])
    mockImport.mockResolvedValue({ ok: true, name: 'work', path: '/p/work', desktop: null })

    await expect(runImportProfileFlow()).resolves.toBe('work')
    expect(selectRemotePaths).toHaveBeenCalled()
    expect(mockImport).toHaveBeenCalledWith('/srv/hermes/work.tar.gz', undefined)
  })

  it('import is a clean cancel when nothing is picked', async () => {
    vi.mocked(selectRemotePaths).mockResolvedValue([])

    await expect(runImportProfileFlow()).resolves.toBeNull()
    expect(mockImport).not.toHaveBeenCalled()
  })
})
