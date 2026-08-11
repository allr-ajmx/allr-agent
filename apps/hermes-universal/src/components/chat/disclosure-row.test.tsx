import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DisclosureRow } from './disclosure-row'

afterEach(cleanup)

function caretWrapper(): Element {
  const button = screen.getByRole('button')
  const wrapper = button.lastElementChild

  if (!wrapper) {
    throw new Error('disclosure row rendered no caret')
  }

  return wrapper
}

describe('DisclosureRow caret', () => {
  // The resting opacity has to come from `--disclosure-caret-rest`, not a
  // hard-coded `opacity-0`: that token is the only way a surface can opt into a
  // faint hint of the affordance, and the thinking header (styles.css,
  // `[data-slot='aui_thinking-disclosure']`) does exactly that. Hard-coding it
  // leaves a run of thinking headers with no discoverable disclosure at all.
  it('rests at the token, not at hard zero', () => {
    render(
      <DisclosureRow onToggle={() => {}} open={false}>
        <span>Thinking</span>
      </DisclosureRow>
    )

    expect(caretWrapper().className).toContain('opacity-(--disclosure-caret-rest)')
    expect(caretWrapper().className).not.toContain('opacity-0 ')
  })

  it('is fully shown while open', () => {
    render(
      <DisclosureRow onToggle={() => {}} open>
        <span>Thinking</span>
      </DisclosureRow>
    )

    expect(caretWrapper().className).toContain('opacity-80')
  })
})
