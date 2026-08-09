/**
 * The keep-awake quick-toggle in the status bar. Desktop-only — the inhibitor
 * has no mobile equivalent, and the same `hidden` keeps it out of the phone's
 * Status list, which asks for every item.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so it is erased and cannot trip vi.mock's hoisting.
import type * as PlatformModule from '@/lib/platform'

// Same shim as use-statusbar-items.test.tsx: rendering the bar must not start the
// health poller / getVersion / getStatus.
vi.mock('@/store/system-status', async () => {
  const { atom } = await import('nanostores')

  return {
    $appVersion: atom<null | string>('1.2.3'),
    $gatewayRestarting: atom(false),
    $inferenceStatus: atom(null),
    $statusSnapshot: atom(null),
    runGatewayRestart: vi.fn()
  }
})

const { desktop } = vi.hoisted(() => ({ desktop: { value: true } }))

vi.mock('@/lib/platform', async importActual => ({
  ...(await importActual<typeof PlatformModule>()),
  get IS_DESKTOP() {
    return desktop.value
  }
}))

import { $keepAwake } from '@/store/keep-awake'
import { $statusbarHiddenIds, STATUSBAR_HIDDEN_BY_DEFAULT } from '@/store/statusbar-prefs'

import { Statusbar } from './statusbar'

const renderStatusbar = () =>
  render(
    <MemoryRouter>
      <Statusbar />
    </MemoryRouter>
  )

// Radix needs both to open a context menu in jsdom.
const openContextMenu = (target: HTMLElement) => {
  fireEvent.pointerDown(target, { button: 2, pointerType: 'mouse' })
  fireEvent.contextMenu(target, { button: 2 })
}

beforeEach(() => {
  desktop.value = true
  $statusbarHiddenIds.set([])
  $keepAwake.set(false)
})

afterEach(() => {
  $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
  $keepAwake.set(false)
})

// The button is icon-only, so the tabler class is the only handle on it.
const sunIcon = (container: HTMLElement) => container.querySelector('.tabler-icon-sun')

describe('keep-awake statusbar item', () => {
  it('ships switched on, and can be switched off from the bar menu', () => {
    const { container } = renderStatusbar()

    expect(sunIcon(container)).toBeInTheDocument()
    expect(STATUSBAR_HIDDEN_BY_DEFAULT).not.toContain('keep-awake')

    openContextMenu(screen.getByRole('contentinfo'))
    expect(screen.getByRole('menuitemcheckbox', { name: /Keep awake/ })).toBeInTheDocument()
  })

  it('lights up while the inhibitor is held', () => {
    $keepAwake.set(true)

    const { container } = renderStatusbar()

    expect(sunIcon(container)?.closest('button')).toHaveClass('bg-accent/55')
  })

  it('is absent off desktop', () => {
    desktop.value = false

    const { container } = renderStatusbar()

    expect(sunIcon(container)).not.toBeInTheDocument()
  })
})
