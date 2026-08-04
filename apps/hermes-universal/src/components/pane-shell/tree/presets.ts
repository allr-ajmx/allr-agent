/**
 * Layout presets — the FancyZones treatment.
 *
 * A preset is a CONTRIBUTION (`area: 'layouts'`, `data: LayoutNode`): the app
 * registers its bundled presets as `source: 'core'`, plugins register theirs
 * exactly the same way, and user-saved presets round-trip through storage and
 * re-register as `source: 'user'`. The picker (renderer/layout-picker.tsx) and
 * the titlebar's layout menu read one uniform list via `useContributions`.
 *
 * Ported from desktop `components/pane-shell/tree/presets.ts`; only the storage
 * key namespace differs.
 */

import { registry } from '@/contrib/registry'
import { readJson, writeJson } from '@/lib/storage'

import { isLayoutNode, type LayoutNode } from './model'
import { $layoutTree, applyTree, markActivePreset } from './store'

export const LAYOUTS_AREA = 'layouts'

const USER_KEY = 'hermes.universal.layoutPresets.v1'

interface StoredPreset {
  name: string
  tree: LayoutNode
}

const userDisposers = new Map<string, () => void>()

function loadUserPresets(): Record<string, StoredPreset> {
  const parsed = readJson<Record<string, StoredPreset>>(USER_KEY) ?? {}
  const out: Record<string, StoredPreset> = {}

  for (const [id, preset] of Object.entries(parsed)) {
    if (preset && typeof preset.name === 'string' && isLayoutNode(preset.tree)) {
      out[id] = preset
    }
  }

  return out
}

function persistUserPresets(presets: Record<string, StoredPreset>) {
  writeJson(USER_KEY, presets)
}

function registerUserPreset(id: string, preset: StoredPreset) {
  userDisposers.get(id)?.()
  userDisposers.set(
    id,
    registry.register({ area: LAYOUTS_AREA, data: preset.tree, id, source: 'user', title: preset.name })
  )
}

// Register persisted user presets at module load.
const userPresets = loadUserPresets()

for (const [id, preset] of Object.entries(userPresets)) {
  registerUserPreset(id, preset)
}

/** Save any tree as a named user preset (and make it active). */
export function saveLayoutPresetTree(name: string, tree: LayoutNode): null | string {
  const trimmed = name.trim()

  if (!tree || !trimmed) {
    return null
  }

  const id = `user-${
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || Date.now().toString(36)
  }`

  userPresets[id] = { name: trimmed, tree }
  persistUserPresets(userPresets)
  registerUserPreset(id, userPresets[id])
  markActivePreset(id)

  return id
}

/** Save the CURRENT tree as a named user preset (and make it active). */
export function saveCurrentLayoutAs(name: string) {
  const tree = $layoutTree.get()

  if (tree) {
    saveLayoutPresetTree(name, tree)
  }
}

export function deleteUserPreset(id: string) {
  if (!(id in userPresets)) {
    return
  }

  delete userPresets[id]
  persistUserPresets(userPresets)
  userDisposers.get(id)?.()
  userDisposers.delete(id)
}

export const isUserPreset = (id: string) => id in userPresets

/** Apply a preset's tree (deep-cloned so live edits never mutate the preset). */
export function applyLayoutPreset(id: string, tree: LayoutNode) {
  applyTree(structuredClone(tree), id)
}
