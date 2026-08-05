/**
 * The `hermes.desktop.*` → `hermes.layout.*` key migration (MJXHRM-171).
 *
 * Worth its own test because the failure mode is silent data loss: get this
 * wrong and every existing install boots to a default layout with no error, and
 * the old value is already gone.
 *
 * The migration runs at MODULE IMPORT (before any atom initialiser reads a
 * key), so each case seeds localStorage and then imports the store fresh.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const TREE_LEGACY = 'hermes.desktop.layoutTree.v2'
const TREE_CURRENT = 'hermes.layout.tree.v2'
const PRESET_LEGACY = 'hermes.desktop.layoutPreset.active'
const PRESET_CURRENT = 'hermes.layout.preset.active'

const importStore = async () => {
  vi.resetModules()

  return import('./store')
}

beforeEach(() => {
  localStorage.clear()
})

describe('legacy key migration', () => {
  it('carries a legacy value forward and drops the old key', async () => {
    localStorage.setItem(PRESET_LEGACY, 'quad')

    await importStore()

    expect(localStorage.getItem(PRESET_CURRENT)).toBe('quad')
    expect(localStorage.getItem(PRESET_LEGACY)).toBeNull()
  })

  it('carries the persisted TREE, so an existing install keeps its layout', async () => {
    const tree = JSON.stringify({ type: 'group', id: 'z', panes: ['workspace'], active: 'workspace' })
    localStorage.setItem(TREE_LEGACY, tree)

    const { $layoutTree } = await importStore()

    expect(localStorage.getItem(TREE_CURRENT)).toBe(tree)
    expect($layoutTree.get()).toMatchObject({ panes: ['workspace'] })
  })

  it('never clobbers a value already written under the new name', async () => {
    localStorage.setItem(PRESET_CURRENT, 'focus')
    localStorage.setItem(PRESET_LEGACY, 'quad')

    await importStore()

    expect(localStorage.getItem(PRESET_CURRENT)).toBe('focus')
    // The stale legacy key still goes away — it can never win again.
    expect(localStorage.getItem(PRESET_LEGACY)).toBeNull()
  })

  it('is a no-op on a fresh install — no desktop key is ever written', async () => {
    await importStore()

    expect(Object.keys(localStorage).filter(k => k.startsWith('hermes.desktop.'))).toEqual([])
  })
})
