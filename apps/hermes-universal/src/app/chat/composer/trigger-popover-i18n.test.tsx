import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

import { ComposerTriggerPopover } from './trigger-popover'

/**
 * The popover's own copy, read through a non-English catalog.
 *
 * Ported from desktop's `trigger-popover.test.tsx`, which universal never got.
 * The empty and loading states are the only strings this component owns, and
 * they are the easiest place for a literal to creep back in — a hardcoded
 * "No matches" passes every structural test in the file next door.
 */
vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: TRANSLATIONS.zh })
}))

const noop = () => {}

function renderPopover(kind: ':' | '@' | '/', loading = false) {
  return render(
    <ComposerTriggerPopover activeIndex={0} items={[]} kind={kind} loading={loading} onHover={noop} onPick={noop} />
  )
}

afterEach(cleanup)

describe('ComposerTriggerPopover i18n', () => {
  it('renders localized empty lookup copy for @ references', () => {
    const { container } = renderPopover('@')

    expect(screen.getByText('没有匹配项。')).toBeTruthy()
    expect(container.textContent).toContain('试试')
    expect(container.textContent).toContain('@file:')
    expect(container.textContent).toContain('或')
    expect(container.textContent).toContain('@folder:')
  })

  it('renders localized loading copy for slash commands', () => {
    renderPopover('/', true)

    // While loading the popover shows only the spinner + loading copy — the
    // `/help` empty-state hint is reserved for the resolved (not-loading) state.
    expect(screen.getByText('查找中…')).toBeTruthy()
  })

  it('renders the slash empty-state hint when not loading', () => {
    const { container } = renderPopover('/')

    expect(screen.getByText('没有匹配项。')).toBeTruthy()
    expect(container.textContent).toContain('/help')
  })

  it('renders the emoji empty-state hint', () => {
    const { container } = renderPopover(':')

    expect(screen.getByText('没有匹配项。')).toBeTruthy()
    expect(container.textContent).toContain(':joy:')
  })
})
