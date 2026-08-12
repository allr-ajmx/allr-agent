import { afterEach, describe, expect, it } from 'vitest'

import { $pendingClose, resolvePendingClose } from './close-confirm'
import {
  $activePreviewPath,
  $activePreviewTarget,
  $previewTabs,
  closeAllPreviewTabs,
  closePreviewTab,
  previewCloseTargets,
  requestCloseAllPreviewTabs,
  requestCloseOtherPreviewTabs,
  requestClosePreviewTab,
  requestClosePreviewTabsToRight,
  selectPreviewTab,
  setPreviewTarget
} from './preview'
import { $dirtyPreviewPaths, setPreviewDirty } from './preview-edit'
import { $previewCaps, $previewModes, setPreviewCaps, setPreviewMode } from './preview-view'

afterEach(() => {
  // Drain any prompt a test parked, so one test's unanswered question cannot
  // de-duplicate the next test's.
  while ($pendingClose.get()) {
    resolvePendingClose($pendingClose.get()!.token, false)
  }

  closeAllPreviewTabs()
})

describe('preview tabs store', () => {
  it('opens a tab (basename label) and makes it active', () => {
    setPreviewTarget('/repo/src/app.ts')
    expect($previewTabs.get()).toEqual([{ name: 'app.ts', path: '/repo/src/app.ts' }])
    expect($activePreviewPath.get()).toBe('/repo/src/app.ts')
    expect($activePreviewTarget.get()?.name).toBe('app.ts')
  })

  it('re-activates an already-open tab instead of duplicating it', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/a.ts')
    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts', '/b.ts'])
    expect($activePreviewPath.get()).toBe('/a.ts')
  })

  it('closing the active tab falls back to the last remaining, then null', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    closePreviewTab('/b.ts')
    expect($activePreviewPath.get()).toBe('/a.ts')
    closePreviewTab('/a.ts')
    expect($activePreviewPath.get()).toBeNull()
  })

  it('closeOthers keeps only the given tab; closeAll clears everything', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/c.ts')
    requestCloseOtherPreviewTabs('/b.ts')
    expect($previewTabs.get().map(t => t.path)).toEqual(['/b.ts'])
    expect($activePreviewPath.get()).toBe('/b.ts')
    closeAllPreviewTabs()
    expect($previewTabs.get()).toEqual([])
    expect($activePreviewPath.get()).toBeNull()
  })

  // MJXHRM-409. The fourth verb of the shared close group — the rail offered
  // three, and the label for the fourth had been sitting in the translations
  // wired to nothing.
  it('closeToRight drops everything past the given tab and rehomes the active one', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/c.ts')

    requestClosePreviewTabsToRight('/a.ts')

    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts'])
    // `/c.ts` was active and is gone, so the anchor takes over rather than
    // leaving the rail pointed at a closed file.
    expect($activePreviewPath.get()).toBe('/a.ts')
  })

  it('closeToRight leaves the active tab alone when it survives', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/c.ts')
    selectPreviewTab('/a.ts')

    requestClosePreviewTabsToRight('/b.ts')

    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts', '/b.ts'])
    expect($activePreviewPath.get()).toBe('/a.ts')
  })

  it('closeToRight is a no-op on the rightmost tab and on an unknown one', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')

    requestClosePreviewTabsToRight('/b.ts')
    requestClosePreviewTabsToRight('/nope.ts')

    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts', '/b.ts'])
  })

  // Every door out has to forget the per-path state, not just the tile's ✕ —
  // a dirty flag left behind keeps claiming unsaved work in a tab that is gone.
  it.each([
    ['requestClosePreviewTab', () => requestClosePreviewTab('/a.ts')],
    ['requestCloseOtherPreviewTabs', () => requestCloseOtherPreviewTabs('/b.ts')],
    ['requestClosePreviewTabsToRight', () => requestClosePreviewTabsToRight('/b.ts')],
    ['requestCloseAllPreviewTabs', () => requestCloseAllPreviewTabs()]
  ])('%s forgets the closed tab’s view mode, caps and dirty flag', (_name, close) => {
    setPreviewTarget('/b.ts')
    setPreviewTarget('/a.ts')
    setPreviewMode('/a.ts', 'diff')
    setPreviewCaps('/a.ts', { rendered: true, source: true })
    setPreviewDirty('/a.ts', true)

    close()
    // Dirty, so every one of these verbs ASKS first (MJXHRM-390) — the tab is
    // still open until the answer lands, which is the whole point.
    expect($previewTabs.get().some(tab => tab.path === '/a.ts')).toBe(true)
    resolvePendingClose($pendingClose.get()!.token, true)

    expect($previewTabs.get().some(tab => tab.path === '/a.ts')).toBe(false)
    expect($previewModes.get()['/a.ts']).toBeUndefined()
    expect($previewCaps.get()['/a.ts']).toBeUndefined()
    expect($dirtyPreviewPaths.get().has('/a.ts')).toBe(false)
  })

  // The hole MJXHRM-390 closed on the file side: the editor's buffer is
  // component state, so an unmount takes the typing with it — and
  // `closePreviewTab` cleared the dirty flag on the way out, leaving nothing to
  // say work had been lost.
  it('keeps a dirty tab open when the close is declined', () => {
    setPreviewTarget('/a.ts')
    setPreviewDirty('/a.ts', true)

    requestClosePreviewTab('/a.ts')
    expect($pendingClose.get()).toMatchObject({ id: '/a.ts', kind: 'file' })

    resolvePendingClose($pendingClose.get()!.token, false)

    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts'])
    expect($dirtyPreviewPaths.get().has('/a.ts')).toBe(true)
  })

  it('closes a CLEAN tab with no prompt at all', () => {
    setPreviewTarget('/a.ts')

    requestClosePreviewTab('/a.ts')

    expect($pendingClose.get()).toBeNull()
    expect($previewTabs.get()).toEqual([])
  })

  // The gateway-switch teardown is not a question: those tabs name files on a
  // machine the app has stopped talking to.
  it('closeAllPreviewTabs (the gateway teardown) never asks', () => {
    setPreviewTarget('/a.ts')
    setPreviewDirty('/a.ts', true)

    closeAllPreviewTabs()

    expect($pendingClose.get()).toBeNull()
    expect($previewTabs.get()).toEqual([])
  })

  // "Close others" over three dirty tabs used to be one batch write; the shared
  // gate parks one prompt PER target so none is swept away unasked.
  it('a bulk close queues one prompt per dirty tab', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/c.ts')
    setPreviewDirty('/a.ts', true)
    setPreviewDirty('/c.ts', true)

    requestCloseOtherPreviewTabs('/b.ts')

    // The clean tab never existed as a question; the two dirty ones queued.
    expect($pendingClose.get()?.id).toBe('/a.ts')
    resolvePendingClose($pendingClose.get()!.token, true)
    expect($pendingClose.get()?.id).toBe('/c.ts')
    resolvePendingClose($pendingClose.get()!.token, false)

    expect($previewTabs.get().map(t => t.path)).toEqual(['/b.ts', '/c.ts'])
  })

  it('counts what each verb would close, so the menu disables the dead ones', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')
    setPreviewTarget('/c.ts')

    expect(previewCloseTargets('/a.ts')).toEqual({ all: 3, others: 2, right: 2 })
    expect(previewCloseTargets('/c.ts')).toEqual({ all: 3, others: 2, right: 0 })
    expect(previewCloseTargets('/gone.ts')).toEqual({ all: 3, others: 0, right: 0 })
  })
})
