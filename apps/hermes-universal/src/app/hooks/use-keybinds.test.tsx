import { fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ⌘N and ⌘T must go through the ONE helper every other new-session entry point
// uses, or the focus behaviour drifts back apart (MJXHRM-6).
vi.mock('@/store/new-session', () => ({
  startNewSession: vi.fn(),
  startNewSessionTab: vi.fn()
}))

vi.mock('@/app/chat/composer/focus', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestComposerFocus: vi.fn()
}))

import { requestComposerFocus } from '@/app/chat/composer/focus'
import { $commandPaletteOpen } from '@/store/command-palette'
import { $bindings, beginCapture, endCapture, resetAllBindings, setBinding } from '@/store/keybinds'
import { $sidebarOpen, setSidebarOpen } from '@/store/layout'
import { startNewSession, startNewSessionTab } from '@/store/new-session'
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
  vi.clearAllMocks()
  endCapture()
  $commandPaletteOpen.set(false)
  resetAllBindings()
  setSidebarOpen(true)
})

describe('useKeybinds', () => {
  it('routes session.new through the shared new-session helper', () => {
    mount()

    fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true })
    expect(startNewSession).toHaveBeenCalledTimes(1)
  })

  it('routes session.newTab through the shared new-session helper', () => {
    mount()

    fireEvent.keyDown(window, { code: 'KeyT', key: 't', metaKey: true })
    expect(startNewSessionTab).toHaveBeenCalledTimes(1)
  })

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

  // `shift+n` (New session) and `shift+x` (theme) shadowed two capital letters:
  // typing a message that started with one ran the shortcut instead.
  it('types a capital letter into the composer rather than running its shift chord', () => {
    mount()

    fireEvent.keyDown(window, { code: 'KeyN', key: 'N', shiftKey: true })

    expect(startNewSession).not.toHaveBeenCalled()
    expect(requestComposerFocus).toHaveBeenCalledWith('active', { typeChar: 'N' })
  })

  // …but the chord still works where the composer would not have taken the key.
  it('runs the shift chord when a surface owns the keys', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    mount()

    fireEvent.keyDown(window, { code: 'KeyN', key: 'N', shiftKey: true })

    expect(requestComposerFocus).not.toHaveBeenCalled()
    expect(startNewSession).toHaveBeenCalledTimes(1)

    dialog.remove()
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
