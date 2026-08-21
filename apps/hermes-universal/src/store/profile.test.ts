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
  setApiRequestProfile: vi.fn()
}))
// selectProfile() funnels through @/store/profiles' setActiveProfile, which
// invalidates the profile-scoped caches and then bumps the slash-completion
// epoch — so this mock has to carry both exports.
vi.mock('@/lib/query-client', () => ({
  invalidateProfileScopedQueries: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() }
}))
// Switching starts a fresh draft (loaded lazily — the real module would pull
// the whole session graph in, and it is the call that matters here).
vi.mock('@/store/new-session', () => ({ startNewSession: vi.fn() }))
import { startNewSession } from '@/store/new-session'

import {
  $profileColors,
  $profileCreateRequest,
  $profileOrder,
  $profileScope,
  $showAllProfiles,
  ALL_PROFILES,
  cycleProfile,
  normalizeProfileKey,
  requestProfileCreate,
  selectProfile,
  setProfileColor,
  setProfileOrder,
  setShowAllProfiles,
  sortByProfileOrder,
  switchProfileToSlot,
  switchToDefaultProfile,
  toggleShowAllProfiles
} from './profile'
import { $activeProfile, $profiles } from './profiles'

const named = (...names: string[]) => names.map(name => profile({ name }))

beforeEach(() => {
  $profiles.set([])
  $profileOrder.set([])
  $profileColors.set({})
  $showAllProfiles.set(false)
  $activeProfile.set(null)
})
afterEach(() => {
  $profiles.set([])
  $showAllProfiles.set(false)
  $activeProfile.set(null)
})

describe('normalizeProfileKey', () => {
  it('collapses empty/nullish to default and trims', () => {
    expect(normalizeProfileKey(null)).toBe('default')
    expect(normalizeProfileKey('  ')).toBe('default')
    expect(normalizeProfileKey(' work ')).toBe('work')
  })
})

describe('rail order', () => {
  it('ranks stored names first and alphabetises the tail', () => {
    const sorted = sortByProfileOrder(named('zeta', 'alpha', 'work', 'beta'), ['work', 'zeta'])

    expect(sorted.map(p => p.name)).toEqual(['work', 'zeta', 'alpha', 'beta'])
  })

  it('is a pure alphabetical sort with no stored order', () => {
    expect(sortByProfileOrder(named('c', 'a', 'b'), []).map(p => p.name)).toEqual(['a', 'b', 'c'])
  })

  it('does not touch the atom when the order is unchanged', () => {
    setProfileOrder(['a', 'b'])
    const first = $profileOrder.get()

    setProfileOrder(['a', 'b'])
    expect($profileOrder.get()).toBe(first)

    setProfileOrder(['b', 'a'])
    expect($profileOrder.get()).not.toBe(first)
  })
})

describe('rail colors', () => {
  it('sets and clears an override under the normalized key', () => {
    setProfileColor(' work ', 'hsl(200 68% 58%)')
    expect($profileColors.get()).toEqual({ work: 'hsl(200 68% 58%)' })

    setProfileColor('work', null)
    expect($profileColors.get()).toEqual({})
  })
})

describe('$profileScope', () => {
  it('follows the active profile in concrete mode', () => {
    expect($profileScope.get()).toBe('default')

    $activeProfile.set('research')
    expect($profileScope.get()).toBe('research')
  })

  it('reports ALL_PROFILES in browse mode regardless of the active profile', () => {
    $activeProfile.set('research')
    setShowAllProfiles(true)
    expect($profileScope.get()).toBe(ALL_PROFILES)

    toggleShowAllProfiles()
    expect($profileScope.get()).toBe('research')
  })
})

describe('selectProfile', () => {
  it('leaves browse mode and maps default onto null', () => {
    setShowAllProfiles(true)
    selectProfile('default')

    expect($showAllProfiles.get()).toBe(false)
    expect($activeProfile.get()).toBeNull()
  })

  it('activates a named profile', () => {
    selectProfile('research')
    expect($activeProfile.get()).toBe('research')
  })

  // Like desktop: a real switch lands you on a fresh chat in that profile (the
  // open chat keeps the profile it was started in); re-tapping the profile you
  // are already in leaves your chat alone.
  it('starts a fresh draft on a switch but not on a re-tap', async () => {
    vi.mocked(startNewSession).mockClear()

    selectProfile('research')
    await vi.waitFor(() => expect(startNewSession).toHaveBeenCalledTimes(1))

    selectProfile('research')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(startNewSession).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh draft when leaving the all-profiles browse view', async () => {
    vi.mocked(startNewSession).mockClear()
    $activeProfile.set('research')
    setShowAllProfiles(true)

    selectProfile('research')

    await vi.waitFor(() => expect(startNewSession).toHaveBeenCalledTimes(1))
  })
})

describe('hotkey navigation', () => {
  beforeEach(() => {
    $profiles.set([profile({ name: 'default', is_default: true }), ...named('work', 'research')])
  })

  it('switches to the Nth named profile in rail order', () => {
    // Alphabetical without a stored order: research, work.
    switchProfileToSlot(1)
    expect($activeProfile.get()).toBe('research')

    setProfileOrder(['work', 'research'])
    switchProfileToSlot(1)
    expect($activeProfile.get()).toBe('work')
  })

  it('no-ops on an empty slot', () => {
    switchProfileToSlot(9)
    expect($activeProfile.get()).toBeNull()
  })

  it('returns to the default profile', () => {
    selectProfile('work')
    switchToDefaultProfile()
    expect($activeProfile.get()).toBeNull()
  })

  it('cycles forward and wraps around [default, ...named]', () => {
    setProfileOrder(['work', 'research'])

    cycleProfile(1)
    expect($activeProfile.get()).toBe('work')
    cycleProfile(1)
    expect($activeProfile.get()).toBe('research')
    cycleProfile(1)
    expect($activeProfile.get()).toBeNull()
  })

  it('treats browse mode as index -1, so forward lands on the first key', () => {
    $activeProfile.set('research')
    setShowAllProfiles(true)

    cycleProfile(1)
    expect($showAllProfiles.get()).toBe(false)
    expect($activeProfile.get()).toBeNull()
  })

  it('does nothing with fewer than two keys', () => {
    $profiles.set([profile({ name: 'default', is_default: true })])
    cycleProfile(1)
    expect($activeProfile.get()).toBeNull()
  })
})

describe('requestProfileCreate', () => {
  it('bumps the request counter so the rail can open its dialog', () => {
    const before = $profileCreateRequest.get()

    requestProfileCreate()
    expect($profileCreateRequest.get()).toBe(before + 1)
  })
})
