import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

const profile = (over: Partial<ProfileInfo>): ProfileInfo => ({
  name: 'x',
  path: '/p/x',
  is_default: false,
  has_env: false,
  model: null,
  provider: null,
  skill_count: 0,
  ...over
})

vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({
    profiles: [profile({ name: 'default', is_default: true }), profile({ name: 'research' })]
  })),
  createProfile: vi.fn(async () => ({ name: 'new', ok: true, path: '/p/new' })),
  renameProfile: vi.fn(async () => ({ name: 'renamed', ok: true, path: '/p/renamed' })),
  deleteProfile: vi.fn(async () => ({ ok: true, path: '/p/x' })),
  setApiRequestProfile: vi.fn()
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))

import { deleteProfile, setApiRequestProfile } from '@/hermes'
import { invalidateProfileScopedQueries } from '@/lib/query-client'

import {
  $activeProfile,
  $profiles,
  isValidProfileName,
  refreshProfiles,
  removeProfile,
  setActiveProfile
} from './profiles'

const del = vi.mocked(deleteProfile)
const setScope = vi.mocked(setApiRequestProfile)

describe('profiles store', () => {
  beforeEach(() => {
    del.mockClear()
    $profiles.set([])
  })
  afterEach(() => $profiles.set([]))

  it('loads the profile list', async () => {
    await refreshProfiles()
    expect($profiles.get().map(p => p.name)).toEqual(['default', 'research'])
  })

  it('removes a profile optimistically', async () => {
    await refreshProfiles()
    await removeProfile('research')
    expect(del).toHaveBeenCalledWith('research')
    expect($profiles.get().map(p => p.name)).toEqual(['default'])
  })

  it('validates profile names', () => {
    expect(isValidProfileName('research-2')).toBe(true)
    expect(isValidProfileName('my_profile')).toBe(true)
    expect(isValidProfileName('-bad')).toBe(false)
    expect(isValidProfileName('Bad Caps')).toBe(false)
    expect(isValidProfileName('')).toBe(false)
  })
})

describe('setActiveProfile', () => {
  beforeEach(() => {
    setScope.mockClear()
    vi.mocked(invalidateProfileScopedQueries).mockClear()
    $activeProfile.set(null)
  })

  it('re-scopes REST + invalidates queries + updates the atom', () => {
    setActiveProfile('research')
    expect(setScope).toHaveBeenCalledWith('research')
    expect(invalidateProfileScopedQueries).toHaveBeenCalled()
    expect($activeProfile.get()).toBe('research')
  })

  it('is a no-op when unchanged', () => {
    setActiveProfile(null)
    expect(setScope).not.toHaveBeenCalled()
    expect(invalidateProfileScopedQueries).not.toHaveBeenCalled()
  })
})
