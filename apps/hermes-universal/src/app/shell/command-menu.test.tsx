import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PALETTE_AREA } from '@/app/command-palette/contrib'
import { registry } from '@/contrib/registry'
import { $commandMenuOpen } from '@/store/command-menu'

import { CommandMenu } from './command-menu'

const renderMenu = () =>
  render(
    <MemoryRouter>
      <CommandMenu />
    </MemoryRouter>
  )

afterEach(() => $commandMenuOpen.set(false))

describe('CommandMenu', () => {
  it('lists the non-rail views when open and filters by query', () => {
    $commandMenuOpen.set(true)
    renderMenu()

    expect(screen.getByText('Agents')).toBeInTheDocument()
    expect(screen.getByText('Starmap')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'star' } })
    expect(screen.getByText('Starmap')).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  // ⌘K is no longer bound here — it's the rebindable `nav.commandPalette`
  // action, covered in `app/hooks/use-keybinds.test.tsx`.
})

describe('palette contributions', () => {
  const register = (data: unknown, id = 'demo:cmd') =>
    registry.register({ area: PALETTE_AREA, data, id, source: 'plugin:demo' })

  it('lists a contributed command after the core rows and runs it on click', () => {
    const run = vi.fn()
    const dispose = register({ id: 'demo:cmd', label: 'Rebuild index', run })

    $commandMenuOpen.set(true)
    renderMenu()

    expect(screen.getByText('Rebuild index')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Rebuild index'))

    expect(run).toHaveBeenCalledOnce()
    expect($commandMenuOpen.get()).toBe(false)

    dispose()
  })

  it('matches a contributed command on its keywords, not just its label', () => {
    const dispose = register({ id: 'demo:cmd', keywords: ['reindex', 'cache'], label: 'Rebuild index', run: vi.fn() })

    $commandMenuOpen.set(true)
    renderMenu()

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'reindex' } })

    expect(screen.getByText('Rebuild index')).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()

    dispose()
  })

  it('runs the first match on Enter', () => {
    const run = vi.fn()
    const dispose = register({ id: 'demo:cmd', label: 'Zebra command', run })

    $commandMenuOpen.set(true)
    renderMenu()

    const input = screen.getByPlaceholderText('Search')
    fireEvent.change(input, { target: { value: 'zebra' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(run).toHaveBeenCalledOnce()

    dispose()
  })

  it('drops a malformed contribution instead of rendering a dead row', () => {
    const disposers = [
      register({ id: 'demo:no-run', label: 'No run' }, 'demo:no-run'),
      register({ id: 'demo:no-label', run: vi.fn() }, 'demo:no-label')
    ]

    $commandMenuOpen.set(true)
    renderMenu()

    expect(screen.queryByText('No run')).not.toBeInTheDocument()
    // The core rows are untouched.
    expect(screen.getByText('Agents')).toBeInTheDocument()

    for (const dispose of disposers) {
      dispose()
    }
  })

  it('survives a throwing command — the menu still closes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const dispose = register({
      id: 'demo:cmd',
      label: 'Boom',
      run: () => {
        throw new Error('plugin exploded')
      }
    })

    $commandMenuOpen.set(true)
    renderMenu()

    expect(() => fireEvent.click(screen.getByText('Boom'))).not.toThrow()
    expect($commandMenuOpen.get()).toBe(false)

    spy.mockRestore()
    dispose()
  })
})
