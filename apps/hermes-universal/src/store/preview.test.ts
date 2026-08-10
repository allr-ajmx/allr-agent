import { afterEach, describe, expect, it } from 'vitest'

import {
  $activePreviewPath,
  $activePreviewTarget,
  $previewTabs,
  closeAllPreviewTabs,
  closeOtherPreviewTabs,
  closePreviewTab,
  closePreviewTabsToRight,
  previewCloseTargets,
  selectPreviewTab,
  setPreviewTarget
} from './preview'

afterEach(() => closeAllPreviewTabs())

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
    closeOtherPreviewTabs('/b.ts')
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

    closePreviewTabsToRight('/a.ts')

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

    closePreviewTabsToRight('/b.ts')

    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts', '/b.ts'])
    expect($activePreviewPath.get()).toBe('/a.ts')
  })

  it('closeToRight is a no-op on the rightmost tab and on an unknown one', () => {
    setPreviewTarget('/a.ts')
    setPreviewTarget('/b.ts')

    closePreviewTabsToRight('/b.ts')
    closePreviewTabsToRight('/nope.ts')

    expect($previewTabs.get().map(t => t.path)).toEqual(['/a.ts', '/b.ts'])
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
