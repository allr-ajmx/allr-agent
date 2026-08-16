/**
 * A platform with no entry in the icon table still renders — it falls back to
 * the first letter of its name. So a missing adapter is not a crash, it is a
 * grey "P" where a brand mark should be, which is exactly the kind of gap that
 * survives review. These pin the two adapters that had no entry.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PlatformAvatar, PlatformGlyph } from './platform-icon'

/** The avatar paints its brand tint inline; an unknown platform does not. */
const tintOf = (element: HTMLElement) => element.style.backgroundColor

describe('Photon', () => {
  it('renders its own mark rather than the unknown-platform monogram', () => {
    const { container } = render(<PlatformAvatar platformId="photon" platformName="iMessage via Photon" />)

    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toBe('')
  })

  it('is painted, not left on the neutral unknown-platform chip', () => {
    const { container } = render(<PlatformAvatar platformId="photon" platformName="iMessage via Photon" />)
    const { container: unknown } = render(<PlatformAvatar platformId="nope" platformName="Nope" />)

    expect(tintOf(container.firstChild as HTMLElement)).not.toBe('')
    expect(tintOf(unknown.firstChild as HTMLElement)).toBe('')
  })

  it('renders in the compact glyph row too', () => {
    const { container } = render(<PlatformGlyph platformId="photon" platformName="iMessage via Photon" />)

    expect(container.querySelector('svg')).not.toBeNull()
  })
})

describe('Buzz', () => {
  // No Simple Icons mark exists for Buzz or Nostr, so this deliberately takes
  // the documented monogram path — but it must be the TABLE's monogram, not the
  // unknown-platform fallback, which is how it would look if the entry were
  // still missing.
  it('renders its monogram on a painted chip, not the unknown-platform chip', () => {
    const { container } = render(<PlatformAvatar platformId="buzz" platformName="Buzz" />)

    expect(container.textContent).toBe('B')
    expect(tintOf(container.firstChild as HTMLElement)).not.toBe('')
  })

  it('greys out in the glyph row when the platform is not connected', () => {
    render(<PlatformGlyph muted platformId="buzz" platformName="Buzz" />)

    const glyph = screen.getByText('B').closest('span[aria-hidden="true"]') as HTMLElement

    expect(glyph.style.color).toContain('--ui-text-tertiary')
  })
})
