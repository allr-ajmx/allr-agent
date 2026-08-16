import { describe, expect, it } from 'vitest'

import { KEYBIND_ACTIONS } from './actions'

const defaultsFor = (id: string): readonly string[] => KEYBIND_ACTIONS.find(action => action.id === id)?.defaults ?? []

describe('keybind defaults', () => {
  it('ships the model picker bound to ⌘⇧M', () => {
    // The chord shipped EMPTY while universal had no picker surface to raise.
    // `app/model-picker-overlay` is that surface, so an unbound action here
    // means ⌘⇧M silently does nothing — the whole point of the shortcut.
    expect(defaultsFor('composer.modelPicker')).toEqual(['mod+shift+m'])
  })

  it('gives no two built-in actions the same default combo', () => {
    const owners = new Map<string, string>()
    const clashes: string[] = []

    for (const action of KEYBIND_ACTIONS) {
      for (const combo of action.defaults) {
        const owner = owners.get(combo)

        if (owner) {
          clashes.push(`${combo}: ${owner} vs ${action.id}`)
        } else {
          owners.set(combo, action.id)
        }
      }
    }

    expect(clashes).toEqual([])
  })
})
