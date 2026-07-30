import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { BUILTIN_THEMES } from './presets'
import type { DesktopTheme } from './types'
import { $userThemes, contributedThemes, installUserTheme, listAllThemes, resolveTheme, THEMES_AREA } from './user-themes'

const USER_THEMES_KEY = 'hermes-user-themes-v1'

const theme = (name: string, label = name): DesktopTheme =>
  ({ colors: { background: '#000', foreground: '#fff', primary: '#0af' }, label, name }) as DesktopTheme

const contribute = (data: unknown, id = 'demo:theme') =>
  registry.register({ area: THEMES_AREA, data, id, source: 'plugin:demo' })

afterEach(() => {
  $userThemes.set({})
  localStorage.clear()
})

describe('contributed themes', () => {
  it('joins the merged set and resolves by name', () => {
    const dispose = contribute(theme('midnight-plugin', 'Midnight'))

    expect(contributedThemes().map(t => t.name)).toEqual(['midnight-plugin'])
    expect(resolveTheme('midnight-plugin')?.label).toBe('Midnight')
    expect(listAllThemes().map(t => t.name)).toContain('midnight-plugin')

    dispose()
  })

  it('disappears entirely on dispose — a plugin cannot leave a theme behind', () => {
    const dispose = contribute(theme('ghost'))
    expect(resolveTheme('ghost')).toBeTruthy()

    dispose()

    expect(resolveTheme('ghost')).toBeUndefined()
    expect(listAllThemes().map(t => t.name)).not.toContain('ghost')
  })

  it('is never persisted to the user-themes key', () => {
    const dispose = contribute(theme('transient'))

    listAllThemes()
    resolveTheme('transient')

    expect(localStorage.getItem(USER_THEMES_KEY)).toBeNull()
    expect($userThemes.get()).toEqual({})

    dispose()
  })

  it('cannot shadow a built-in name', () => {
    const builtin = Object.keys(BUILTIN_THEMES)[0]
    const dispose = contribute(theme(builtin, 'Hijacked'))

    expect(contributedThemes()).toEqual([])
    expect(resolveTheme(builtin)?.label).not.toBe('Hijacked')

    dispose()
  })

  it('loses to a user install of the same name — an explicit install is intent', () => {
    installUserTheme(theme('shared', 'User install'))
    const dispose = contribute(theme('shared', 'Plugin version'))

    expect(resolveTheme('shared')?.label).toBe('User install')
    expect(listAllThemes().filter(t => t.name === 'shared')).toHaveLength(1)

    dispose()
  })

  it('drops a malformed theme instead of half-applying it', () => {
    const disposers = [
      contribute({ label: 'No colors', name: 'broken' }, 'demo:no-colors'),
      contribute({ colors: { background: '#000' }, label: 'Partial', name: 'partial' }, 'demo:partial'),
      contribute(undefined, 'demo:empty')
    ]

    expect(contributedThemes()).toEqual([])

    for (const dispose of disposers) {
      dispose()
    }
  })

  it('keeps the first of two contributions claiming the same name', () => {
    const disposers = [
      contribute(theme('dup', 'First'), 'demo:a'),
      contribute(theme('dup', 'Second'), 'demo:b')
    ]

    expect(contributedThemes()).toHaveLength(1)
    expect(resolveTheme('dup')?.label).toBe('First')

    for (const dispose of disposers) {
      dispose()
    }
  })
})
