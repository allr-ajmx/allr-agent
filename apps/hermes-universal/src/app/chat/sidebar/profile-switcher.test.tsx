import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PROFILE_SWATCHES, resolveProfileColor } from '@/lib/profile-color'
import { $profileColors, $profileOrder, $showAllProfiles } from '@/store/profile'
import { $activeProfile, $profiles } from '@/store/profiles'
import type { ProfileInfo } from '@/types/hermes'

import { ProfileRail, RAIL_VISIBLE_LIMIT } from './profile-switcher'

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
})

describe('ProfileRail — overflow menu', () => {
  // RAIL_VISIBLE_LIMIT named squares stay inline; the rest spill into the "⌄".
  const seed = (count: number) =>
    $profiles.set([profile('default', true), ...Array.from({ length: count }, (_, i) => profile(`p${i}`))])

  // Derived from the limit, not hard-coded: the limit differs between the phone
  // and the desktop, and names pinned to one of them would quietly stop testing
  // the boundary they were chosen to sit on.
  const lastInline = `p${RAIL_VISIBLE_LIMIT - 1}`
  const firstSpilled = `p${RAIL_VISIBLE_LIMIT}`
  const lastSpilled = `p${RAIL_VISIBLE_LIMIT + 1}`

  const overflow = () => screen.getByRole('button', { name: 'More profiles' })
  // The popover content, not the trigger — both carry the same accessible name.
  const grid = () => within(screen.getByRole('dialog', { name: 'More profiles' }))

  it('keeps every square inline at the visible limit', () => {
    seed(RAIL_VISIBLE_LIMIT)
    renderRail()

    expect(square(lastInline)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More profiles' })).not.toBeInTheDocument()
  })

  it('spills the tail into the overflow menu past the limit', () => {
    seed(RAIL_VISIBLE_LIMIT + 2)
    renderRail()

    expect(square(lastInline)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: firstSpilled })).not.toBeInTheDocument()
    expect(overflow()).toBeInTheDocument()
  })

  it('shows only the hidden profiles in the grid and switches on click', () => {
    seed(RAIL_VISIBLE_LIMIT + 2)
    renderRail()

    fireEvent.click(overflow())

    expect(grid().getByRole('button', { name: firstSpilled })).toBeInTheDocument()
    expect(grid().getByRole('button', { name: lastSpilled })).toBeInTheDocument()
    expect(grid().queryByRole('button', { name: 'p0' })).not.toBeInTheDocument()

    fireEvent.click(grid().getByRole('button', { name: lastSpilled }))
    expect($activeProfile.get()).toBe(lastSpilled)
    expect(screen.queryByRole('dialog', { name: 'More profiles' })).not.toBeInTheDocument()
  })

  it('hoists a hidden active profile back onto the rail and out of the grid', () => {
    seed(RAIL_VISIBLE_LIMIT + 2)
    $activeProfile.set(firstSpilled)
    renderRail()

    expect(square(firstSpilled)).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(overflow())
    expect(grid().getByRole('button', { name: lastSpilled })).toBeInTheDocument()
    expect(grid().queryByRole('button', { name: firstSpilled })).not.toBeInTheDocument()
  })

  // The grid renders the rail's own ProfileSquare, so a spilled profile keeps
  // every gesture. (Drag back onto the rail needs layout jsdom doesn't have.)
  describe('square gestures', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

    it('opens the color picker on long-press and writes the override', () => {
      seed(RAIL_VISIBLE_LIMIT + 2)
      renderRail()
      fireEvent.click(overflow())

      const target = grid().getByRole('button', { name: firstSpilled })
      fireEvent.pointerDown(target, { button: 0 })
      act(() => vi.advanceTimersByTime(450))

      const swatch = PROFILE_SWATCHES[2]
      fireEvent.click(
        within(screen.getByLabelText(`Color for ${firstSpilled}`)).getByRole('button', { name: `Set color ${swatch}` })
      )
      expect($profileColors.get()).toEqual({ [firstSpilled]: swatch })
    })

    it('opens the per-square context menu', () => {
      seed(RAIL_VISIBLE_LIMIT + 2)
      renderRail()
      fireEvent.click(overflow())

      fireEvent.contextMenu(grid().getByRole('button', { name: firstSpilled }))

      const menu = within(screen.getByLabelText(`Actions for ${firstSpilled}`))
      expect(menu.getByText('Color…')).toBeInTheDocument()
      expect(menu.getByText('Rename…')).toBeInTheDocument()
      expect(menu.getByText('Edit SOUL.md…')).toBeInTheDocument()
      expect(menu.getByText('Delete')).toBeInTheDocument()
    })
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

/**
 * One size for the whole strip.
 *
 * The rail mixes two button implementations: `Button` (the home/Manage pills)
 * and raw `<button>` (the squares, "+", "⌄"). The app's coarse-pointer touch
 * floor keys on `data-slot` / `data-variant`, which only `Button` writes — and
 * the squares' nested Radix `asChild` triggers overwrite `data-slot` anyway — so
 * on a phone the pills stood at 48px beside ~22px squares. The fix is a shared
 * `profile-rail-control` class that styles.css sizes to `--touch-target-compact`.
 *
 * What this holds is the wiring, in both halves: every control in the rail
 * carries the marker (a NEW button added without it is the regression), and the
 * stylesheet still sizes that marker. Neither half is worth anything alone, and
 * jsdom cannot answer the pixel question — it never sets `html.is-mobile` and
 * does not resolve the token — so this is the assertion that fits.
 */
describe('ProfileRail — one size for the whole strip', () => {
  const seed = (count: number) =>
    $profiles.set([profile('default', true), ...Array.from({ length: count }, (_, i) => profile(`p${i}`))])

  const railControls = (root: HTMLElement) => [
    ...(root.querySelector('[data-slot="profile-rail"]')?.querySelectorAll('button') ?? [])
  ]

  it('marks every control on the strip — pills, squares, "+" and "⌄" alike', () => {
    seed(RAIL_VISIBLE_LIMIT + 2)
    const { container } = renderRail()

    const controls = railControls(container)

    // The home pill, one square per inline profile, "+", "⌄", the Manage pill.
    expect(controls).toHaveLength(RAIL_VISIBLE_LIMIT + 4)

    for (const control of controls) {
      expect(control).toHaveClass('profile-rail-control')
    }
  })

  it('marks the hoisted square, which is a stand-in rather than a reorder cell', () => {
    seed(RAIL_VISIBLE_LIMIT + 2)
    $activeProfile.set(`p${RAIL_VISIBLE_LIMIT}`)
    const { container } = renderRail()

    expect(square(`p${RAIL_VISIBLE_LIMIT}`)).toHaveClass('profile-rail-control')
    expect(railControls(container)).toHaveLength(RAIL_VISIBLE_LIMIT + 5)
  })

  it('marks the spilled squares too — they portal out of the rail, not out of the rule', () => {
    seed(RAIL_VISIBLE_LIMIT + 2)
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'More profiles' }))

    const grid = within(screen.getByRole('dialog', { name: 'More profiles' }))

    for (const name of [`p${RAIL_VISIBLE_LIMIT}`, `p${RAIL_VISIBLE_LIMIT + 1}`]) {
      expect(grid.getByRole('button', { name })).toHaveClass('profile-rail-control')
    }
  })

  it('sizes that marker to the compact touch target, not the 48px floor', () => {
    const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../styles.css'), 'utf8')

    // Both axes, so the strip is square, and off `--touch-target-compact` so it
    // tracks the one token dense chrome already uses.
    expect(css).toMatch(
      /html\.is-mobile button\.profile-rail-control \{\s*min-block-size: var\(--touch-target-compact\);\s*min-inline-size: var\(--touch-target-compact\);/
    )
    // The shared corner rides on the same class, so the strip cannot end up
    // one size with two radii.
    expect(css).toMatch(/@utility profile-rail-control \{\s*border-radius: 4px;/)
  })
})
