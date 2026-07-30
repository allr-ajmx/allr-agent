import { afterEach, describe, expect, it } from 'vitest'

import { canonicalizeCombo } from '@/lib/keybinds/combo'

import {
  $bindings,
  $comboIndex,
  bindingsFor,
  conflictsFor,
  resetAllBindings,
  resetBinding,
  setBinding
} from './keybinds'

afterEach(resetAllBindings)

describe('keybind bindings', () => {
  it('ships desktop defaults and resolves them through bindingsFor', () => {
    expect(bindingsFor('view.toggleSidebar')).toEqual(['mod+b'])
    expect(bindingsFor('nav.commandPalette')).toEqual(['mod+k', 'mod+p'])
  })

  it('binds the multi-session tile/tab actions to their defaults', () => {
    expect(bindingsFor('session.newTab')).toEqual(['mod+t'])
    expect(bindingsFor('view.closeTab')).toEqual(['mod+w'])
    expect(bindingsFor('view.reopenTab')).toEqual(['mod+shift+t'])
  })

  it('binds session.newWindow now that native multi-window ships (MJX-104)', () => {
    expect(bindingsFor('session.newWindow')).toEqual(['mod+shift+n'])
  })

  it('binds profile.toggleAll now that the browse scope ships (MJX-108)', () => {
    expect(bindingsFor('profile.toggleAll')).toEqual(['mod+shift+0'])
  })

  it('overrides then resets a single binding', () => {
    setBinding('view.toggleSidebar', ['mod+y'])
    expect(bindingsFor('view.toggleSidebar')).toEqual(['mod+y'])

    resetBinding('view.toggleSidebar')
    expect(bindingsFor('view.toggleSidebar')).toEqual(['mod+b'])
  })

  it('ignores writes to unknown action ids', () => {
    setBinding('nope.notAnAction', ['mod+q'])
    expect($bindings.get()['nope.notAnAction']).toBeUndefined()
  })

  it('persists only the diff from defaults', () => {
    setBinding('view.toggleSidebar', ['mod+y'])

    const stored = JSON.parse(localStorage.getItem('hermes.universal.keybinds') ?? '{}')
    expect(stored).toEqual({ 'view.toggleSidebar': ['mod+y'] })

    resetAllBindings()
    expect(JSON.parse(localStorage.getItem('hermes.universal.keybinds') ?? '{}')).toEqual({})
  })

  it('reports conflicts against other actions using the same combo', () => {
    expect(conflictsFor('view.toggleSidebar', 'mod+b')).toEqual([])

    setBinding('view.showFiles', ['mod+b'])
    expect(conflictsFor('view.toggleSidebar', 'mod+b')).toContain('view.showFiles')
  })

  it('indexes combos to action ids, first action winning a duplicate', () => {
    const index = $comboIndex.get()

    expect(index.get(canonicalizeCombo('mod+b'))).toBe('view.toggleSidebar')
    // Both of nav.commandPalette's defaults resolve to it.
    expect(index.get(canonicalizeCombo('mod+k'))).toBe('nav.commandPalette')
    expect(index.get(canonicalizeCombo('mod+p'))).toBe('nav.commandPalette')
  })
})
