import { fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { $commandPaletteOpen } from '@/store/command-palette'
import { $bindings, beginCapture, endCapture, resetAllBindings, setBinding } from '@/store/keybinds'
import { $sidebarOpen, setSidebarOpen } from '@/store/layout'
import { ThemeProvider } from '@/themes/context'

import { useKeybinds } from './use-keybinds'

function Harness() {
  useKeybinds({ toggleCommandCenter: () => {} })

  return null
}

function mount() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <Harness />
      </ThemeProvider>
    </MemoryRouter>
  )
}

afterEach(() => {
  endCapture()
  $commandPaletteOpen.set(false)
  resetAllBindings()
  setSidebarOpen(true)
})

describe('useKeybinds', () => {
  it('dispatches view.toggleSidebar on its default mod+b binding', () => {
    setSidebarOpen(true)
    mount()

    fireEvent.keyDown(window, { code: 'KeyB', key: 'b', metaKey: true })
    expect($sidebarOpen.get()).toBe(false)

    fireEvent.keyDown(window, { code: 'KeyB', key: 'b', ctrlKey: true })
    expect($sidebarOpen.get()).toBe(true)
  })

  it('ignores a bare "b" without a modifier', () => {
    setSidebarOpen(true)
    mount()

    fireEvent.keyDown(window, { code: 'KeyB', key: 'b' })
    expect($sidebarOpen.get()).toBe(true)
  })

  it('follows a rebind — the new combo fires and the old one goes dead', () => {
    setSidebarOpen(true)
    setBinding('view.toggleSidebar', ['mod+y'])
    mount()

    fireEvent.keyDown(window, { code: 'KeyB', key: 'b', metaKey: true })
    expect($sidebarOpen.get()).toBe(true)

    fireEvent.keyDown(window, { code: 'KeyY', key: 'y', metaKey: true })
    expect($sidebarOpen.get()).toBe(false)
  })

  it('opens the command menu on nav.commandPalette (⌘K)', () => {
    $commandPaletteOpen.set(false)
    mount()

    fireEvent.keyDown(window, { code: 'KeyK', key: 'k', metaKey: true })
    expect($commandPaletteOpen.get()).toBe(true)
  })

  it('captures the next combo into the armed action instead of running it', () => {
    setSidebarOpen(true)
    mount()

    // Arm 'view.toggleSidebar' for rebinding, then press ⌘J.
    beginCapture('view.toggleSidebar')
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true })

    expect($bindings.get()['view.toggleSidebar']).toEqual(['mod+j'])
    // The press was swallowed by capture mode, not dispatched.
    expect($sidebarOpen.get()).toBe(true)
  })
})
