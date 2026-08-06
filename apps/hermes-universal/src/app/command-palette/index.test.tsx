import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { queryClient } from '@/lib/query-client'
import { $commandPaletteOpen } from '@/store/command-palette'
import type * as WindowsStore from '@/store/windows'
import { openAppRoute } from '@/store/windows'

import { PALETTE_AREA } from './contrib'

import { CommandPalette } from './index'

// The palette lazily fetches sessions + config while open; neither is the
// subject here, and both would otherwise hit the gateway.
vi.mock('@/hermes', () => ({
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({})),
  listAllProfileSessions: vi.fn(async () => ({ sessions: [], total: 0, offset: 0 }))
}))

// Navigation is the seam every row goes through — assert on it rather than on a
// router the palette deliberately doesn't use.
vi.mock('@/store/windows', async importOriginal => ({
  ...(await importOriginal<typeof WindowsStore>()),
  openAppRoute: vi.fn()
}))

const renderPalette = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <CommandPalette />
    </QueryClientProvider>
  )

const openPalette = () => {
  $commandPaletteOpen.set(true)

  return renderPalette()
}

// Queried by role, not placeholder: a nested page swaps the placeholder for
// its own copy.
const input = () => screen.getByRole('combobox')

afterEach(() => {
  cleanup()
  $commandPaletteOpen.set(false)
  queryClient.clear()
  vi.clearAllMocks()
})

describe('CommandPalette', () => {
  it('lists the app destinations under Go to and filters by query', () => {
    openPalette()

    expect(screen.getByText('Go to')).toBeInTheDocument()
    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Starmap')).toBeInTheDocument()

    fireEvent.change(input(), { target: { value: 'star' } })

    expect(screen.getByText('Starmap')).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('ranks the best label match first so the auto-highlight lands on it', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'settings' } })

    // cmdk selects the first rendered item on every query change, so "first"
    // is what the ranking has to get right.
    const rows = screen.getAllByRole('option')
    expect(rows[0].textContent).toContain('Settings')
  })

  it('navigates through openAppRoute and closes', () => {
    openPalette()
    fireEvent.click(screen.getByText('Starmap'))

    expect(openAppRoute).toHaveBeenCalledWith('/starmap')
    expect($commandPaletteOpen.get()).toBe(false)
  })

  it('opens a nested page via `to` and steps back out on empty Backspace', () => {
    openPalette()
    fireEvent.click(screen.getByText('Change theme'))

    // The back header names the page, and the root groups are gone.
    expect(screen.getByText('Back')).toBeInTheDocument()
    expect(screen.queryByText('Go to')).not.toBeInTheDocument()
    expect($commandPaletteOpen.get()).toBe(true)

    fireEvent.keyDown(input(), { key: 'Backspace' })

    expect(screen.getByText('Go to')).toBeInTheDocument()
  })

  it('keeps the palette open for a live-preview row', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'dark' } })
    fireEvent.click(screen.getAllByText('Dark')[0])

    // Theme/mode rows preview in place — closing would hide the result.
    expect($commandPaletteOpen.get()).toBe(true)
  })

  it('shows a no-results message rather than an empty surface', () => {
    openPalette()
    fireEvent.change(input(), { target: { value: 'zzzznothing' } })

    expect(screen.getByText('No matching results found.')).toBeInTheDocument()
  })
})

describe('palette contributions', () => {
  const register = (data: unknown, id = 'demo:cmd') =>
    registry.register({ area: PALETTE_AREA, data, id, source: 'plugin:demo' })

  it('groups plugin commands apart from the app destinations and runs one on click', () => {
    const run = vi.fn()
    const dispose = register({ id: 'demo:cmd', label: 'Rebuild index', run })

    openPalette()

    // Its own group, so a plugin row never masquerades as a built-in destination.
    expect(screen.getByText('Commands')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Rebuild index'))

    expect(run).toHaveBeenCalledOnce()
    expect($commandPaletteOpen.get()).toBe(false)

    dispose()
  })

  it('omits the Commands group when nothing contributes', () => {
    openPalette()

    expect(screen.queryByText('Commands')).not.toBeInTheDocument()
  })

  it('matches a contributed command on its keywords, not just its label', () => {
    const dispose = register({ id: 'demo:cmd', keywords: ['reindex', 'cache'], label: 'Rebuild index', run: vi.fn() })

    openPalette()
    fireEvent.change(input(), { target: { value: 'reindex' } })

    expect(screen.getByText('Rebuild index')).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()

    dispose()
  })

  it('runs the highlighted match on Enter', () => {
    const run = vi.fn()
    const dispose = register({ id: 'demo:cmd', label: 'Zebra command', run })

    openPalette()
    fireEvent.change(input(), { target: { value: 'zebra' } })
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(run).toHaveBeenCalledOnce()

    dispose()
  })

  it('drops a malformed contribution instead of rendering a dead row', () => {
    const disposers = [
      register({ id: 'demo:no-run', label: 'No run' }, 'demo:no-run'),
      register({ id: 'demo:no-label', run: vi.fn() }, 'demo:no-label')
    ]

    openPalette()

    expect(screen.queryByText('No run')).not.toBeInTheDocument()
    // The core rows are untouched.
    expect(screen.getByText('Agents')).toBeInTheDocument()

    for (const dispose of disposers) {
      dispose()
    }
  })

  it('survives a throwing command — the palette still closes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const dispose = register({
      id: 'demo:cmd',
      label: 'Boom',
      run: () => {
        throw new Error('plugin exploded')
      }
    })

    openPalette()

    expect(() => fireEvent.click(screen.getByText('Boom'))).not.toThrow()
    expect($commandPaletteOpen.get()).toBe(false)

    spy.mockRestore()
    dispose()
  })
})
