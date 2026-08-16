import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { $panesFlipped, $rightSidebarOpen, $sidebarOpen, setSidebarOpen } from '@/store/layout'

// The titlebar mounts WindowControls, which reaches for the real Tauri window.
const win = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {})
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))

// The floating-surface capability query. Settable, because whether this
// platform can put a window over other applications is what decides whether the
// HUD button belongs in the chrome at all.
const caps = vi.hoisted(() => ({ floatingSurface: true }))

vi.mock('@/lib/surface', () => ({
  setSurfaceInteractiveRect: vi.fn(),
  surfaceCapabilities: async () => caps
}))

import { Titlebar } from './titlebar'

const renderTitlebar = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <Titlebar connected />
      </I18nProvider>
    </MemoryRouter>
  )

afterEach(() => {
  setSidebarOpen(true)
  $rightSidebarOpen.set(false)
  $panesFlipped.set(false)
  caps.floatingSurface = true
})

describe('the HUD affordance', () => {
  // `lib/surface.ts`: read `floatingSurface` to decide whether to offer the UI
  // at all. Where there is none, this button opens an ordinary window that sits
  // BEHIND whatever the user is working in — the opposite of what it promises.
  it('offers the HUD where the platform can float a window', async () => {
    renderTitlebar()

    expect(await screen.findByRole('button', { name: 'HUD mode' })).toBeInTheDocument()
  })

  it('does not offer it where the platform cannot', async () => {
    caps.floatingSurface = false

    renderTitlebar()

    // Settle the capability probe, then check — asserting on the first frame
    // would pass for the wrong reason, since the button starts hidden either way.
    await screen.findByRole('button', { name: 'Open settings' })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: 'HUD mode' })).not.toBeInTheDocument()
  })
})

describe('Titlebar sidebar toggles', () => {
  it('drives the chat sidebar / file rails by identity while unflipped', () => {
    setSidebarOpen(true)
    $rightSidebarOpen.set(false)
    renderTitlebar()

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect($sidebarOpen.get()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Show right sidebar' }))
    expect($rightSidebarOpen.get()).toBe(true)
  })

  // The bug: after a swap the left button used to keep hiding the chat sidebar,
  // which had moved to the right edge. Toggles are positional now.
  it('follows the swap — the left button drives whatever sits on the left', () => {
    setSidebarOpen(true)
    $rightSidebarOpen.set(false)
    $panesFlipped.set(true)
    renderTitlebar()

    // Left cluster now faces the file rails (closed) → "Show sidebar".
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect($rightSidebarOpen.get()).toBe(true)
    expect($sidebarOpen.get()).toBe(true)

    // Right cluster now faces the chat sidebar (open) → "Hide right sidebar".
    fireEvent.click(screen.getByRole('button', { name: 'Hide right sidebar' }))
    expect($sidebarOpen.get()).toBe(false)
    expect($rightSidebarOpen.get()).toBe(true)
  })
})

describe('titleBar.* contribution areas', () => {
  it('paints contributions into all three areas', () => {
    const disposers = (['left', 'center', 'right'] as const).map(side =>
      registry.register({
        area: `titleBar.${side}`,
        id: `demo:${side}`,
        render: () => <output data-testid={`tool-${side}`}>{side}</output>,
        source: 'plugin:demo'
      })
    )

    renderTitlebar()

    for (const side of ['left', 'center', 'right'] as const) {
      expect(screen.getByTestId(`tool-${side}`).textContent).toBe(side)
    }

    for (const dispose of disposers) {
      dispose()
    }
  })

  it('keeps the center contribution out of the window drag region', () => {
    const dispose = registry.register({
      area: 'titleBar.center',
      id: 'demo:center',
      render: () => <output data-testid="tool-center">center</output>,
      source: 'plugin:demo'
    })

    renderTitlebar()

    // A contributed node inside `data-tauri-drag-region` would move the window on
    // press instead of taking the click.
    expect(screen.getByTestId('tool-center').closest('[data-tauri-drag-region]')).toBeNull()

    dispose()
  })

  it('survives a throwing contribution — the chrome keeps working', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const dispose = registry.register({
      area: 'titleBar.right',
      id: 'demo:boom',
      render: () => {
        throw new Error('plugin exploded')
      },
      source: 'plugin:demo'
    })

    renderTitlebar()

    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()

    spy.mockRestore()
    dispose()
  })
})
