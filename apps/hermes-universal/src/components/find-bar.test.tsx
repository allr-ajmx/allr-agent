/**
 * The find bar in a window with no combo dispatcher.
 *
 * `useKeybinds` mounts only in the main shell, so in a detached tile / HUD /
 * Quick Entry / activity window ⌘F reached nothing at all. The bar carries its
 * own accelerator there — and only there.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $findInPage, closeFindBar } from '@/store/find-in-page'
import { registerKeybindDispatcher, setBinding } from '@/store/keybinds'

import { FindBar } from './find-bar'

// The store gates ⌘F on the platform being able to search at all.
beforeEach(() => {
  Object.defineProperty(window, 'find', { configurable: true, value: () => true, writable: true })
})

afterEach(() => {
  closeFindBar()
  localStorage.clear()
})

function renderBar() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <FindBar />
      </MemoryRouter>
    </I18nProvider>
  )
}

/** ⌘F as the dispatcher's `comboFromEvent` reads it. */
const pressFind = (init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { code: 'KeyF', key: 'f', metaKey: true, ...init })

describe('FindBar', () => {
  it('renders nothing until it is opened', () => {
    renderBar()

    expect(screen.queryByRole('search')).not.toBeInTheDocument()
  })

  it('opens on the find combo in a window with no dispatcher', () => {
    renderBar()

    pressFind()

    expect($findInPage.get().active).toBe(true)
    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  it('stands down where the global dispatcher is mounted, so ⌘F is handled once', () => {
    const release = registerKeybindDispatcher()

    try {
      renderBar()
      pressFind()

      expect($findInPage.get().active).toBe(false)
    } finally {
      release()
    }
  })

  it('follows a rebound find action rather than the ⌘F key itself', () => {
    // ⌥⌘F: unbound by default, so this reads the binding rather than a collision
    // ('mod+shift+f' already ships as session.focusSearch, and the index gives a
    // contested combo to the first action that claims it).
    setBinding('view.findInPage', ['mod+alt+f'])
    renderBar()

    pressFind()
    expect($findInPage.get().active).toBe(false)

    pressFind({ altKey: true })
    expect($findInPage.get().active).toBe(true)
  })

  it('closes on Escape and drops the query with it', () => {
    renderBar()
    pressFind()

    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' })

    expect($findInPage.get()).toMatchObject({ active: false, query: '' })
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
  })
})
