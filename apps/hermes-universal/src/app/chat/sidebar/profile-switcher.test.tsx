import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROFILE_SWATCHES, resolveProfileColor } from '@/lib/profile-color'
import { $profileColors, $profileOrder, $showAllProfiles } from '@/store/profile'
import { $activeProfile, $profiles } from '@/store/profiles'
import type { ProfileInfo } from '@/types/hermes'

import { ProfileRail } from './profile-switcher'

const profile = (name: string, isDefault = false): ProfileInfo => ({
  name,
  path: `/p/${name}`,
  is_default: isDefault,
  has_env: false,
  model: null,
  provider: null,
  skill_count: 0
})

const renderRail = () =>
  render(
    <MemoryRouter>
      <ProfileRail />
    </MemoryRouter>
  )

// A named square is the button whose accessible name is the profile name.
const square = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  $profileOrder.set([])
  $profileColors.set({})
  $showAllProfiles.set(false)
  $activeProfile.set(null)
})

afterEach(() => {
  vi.useRealTimers()
  $profiles.set([])
  $showAllProfiles.set(false)
  $activeProfile.set(null)
})

describe('ProfileRail — single profile', () => {
  it('shows only create + manage, no named squares and no all-profiles toggle', () => {
    $profiles.set([profile('default', true)])
    renderRail()

    expect(screen.getByRole('button', { name: 'New profile' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Manage profiles…' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show all profiles' })).not.toBeInTheDocument()
  })
})

describe('ProfileRail — named squares', () => {
  beforeEach(() => $profiles.set([profile('default', true), profile('research'), profile('work')]))

  it('renders one square per named profile in rail order', () => {
    $profileOrder.set(['work', 'research'])
    renderRail()

    const labels = screen
      .getAllByRole('button')
      .map(node => node.getAttribute('aria-label'))
      .filter(label => label === 'work' || label === 'research')

    expect(labels).toEqual(['work', 'research'])
  })

  it('tints each square with its own resolved profile color', () => {
    renderRail()

    // jsdom re-serializes the hsl() inside color-mix(), so compare shapes rather
    // than the literal string: a soft fill per square, distinct per profile.
    expect(square('research').style.backgroundColor).toContain('color-mix')
    expect(square('research').style.backgroundColor).not.toBe(square('work').style.backgroundColor)
  })

  it('honours a stored color override', () => {
    const override = PROFILE_SWATCHES[7]
    $profileColors.set({ research: override })
    renderRail()

    expect(resolveProfileColor('research', $profileColors.get())).toBe(override)
    expect(square('research').style.backgroundColor).not.toBe(square('work').style.backgroundColor)
  })

  it('marks the active profile pressed and switches on click', () => {
    renderRail()

    expect(square('research')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(square('work'))
    expect($activeProfile.get()).toBe('work')
  })

  it('collapses to a select past the dropdown threshold', () => {
    $profiles.set([profile('default', true), ...Array.from({ length: 13 }, (_, i) => profile(`p${i}`))])
    renderRail()

    expect(screen.getByRole('combobox', { name: 'Profiles' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'p0' })).not.toBeInTheDocument()
  })
})

describe('ProfileRail — long-press recolor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    $profiles.set([profile('default', true), profile('research')])
  })

  it('opens the swatch picker after the hold and swallows the trailing click', () => {
    renderRail()

    fireEvent.pointerDown(square('research'), { button: 0 })
    act(() => vi.advanceTimersByTime(450))

    const picker = screen.getByLabelText('Color for research')
    expect(picker).toBeInTheDocument()

    // The click that ends the hold must not also switch profile.
    fireEvent.click(square('research'))
    expect($activeProfile.get()).toBeNull()
  })

  it('still selects when the press is released before the hold completes', () => {
    renderRail()

    fireEvent.pointerDown(square('research'), { button: 0 })
    act(() => vi.advanceTimersByTime(200))
    fireEvent.pointerUp(square('research'))
    act(() => vi.advanceTimersByTime(400))

    expect(screen.queryByLabelText('Color for research')).not.toBeInTheDocument()

    fireEvent.click(square('research'))
    expect($activeProfile.get()).toBe('research')
  })

  it('writes then clears the color override from the picker', () => {
    renderRail()

    fireEvent.pointerDown(square('research'), { button: 0 })
    act(() => vi.advanceTimersByTime(450))

    const swatch = PROFILE_SWATCHES[3]
    fireEvent.click(
      within(screen.getByLabelText('Color for research')).getByRole('button', { name: `Set color ${swatch}` })
    )
    expect($profileColors.get()).toEqual({ research: swatch })

    fireEvent.pointerDown(square('research'), { button: 0 })
    act(() => vi.advanceTimersByTime(450))
    fireEvent.click(within(screen.getByLabelText('Color for research')).getByRole('button', { name: 'Auto' }))
    expect($profileColors.get()).toEqual({})
  })
})

describe('ProfileRail — per-square context menu', () => {
  it('offers color, rename, SOUL.md and delete', () => {
    $profiles.set([profile('default', true), profile('research')])
    renderRail()

    fireEvent.contextMenu(square('research'))

    const menu = screen.getByLabelText('Actions for research')
    expect(within(menu).getByText('Color…')).toBeInTheDocument()
    expect(within(menu).getByText('Rename…')).toBeInTheDocument()
    expect(within(menu).getByText('Edit SOUL.md…')).toBeInTheDocument()
    expect(within(menu).getByText('Delete')).toBeInTheDocument()
  })
})

describe('ProfileRail — all-profiles toggle', () => {
  beforeEach(() => $profiles.set([profile('default', true), profile('research')]))

  it('enters the browse view from the default profile', () => {
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Show all profiles' }))
    expect($showAllProfiles.get()).toBe(true)
  })

  it('returns home from a named profile instead of entering the browse view', () => {
    $activeProfile.set('research')
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Switch to default' }))
    expect($showAllProfiles.get()).toBe(false)
    expect($activeProfile.get()).toBeNull()
  })

  it('leaves the browse view when a profile is picked', () => {
    $showAllProfiles.set(true)
    renderRail()

    fireEvent.click(square('research'))
    expect($showAllProfiles.get()).toBe(false)
    expect($activeProfile.get()).toBe('research')
  })
})
