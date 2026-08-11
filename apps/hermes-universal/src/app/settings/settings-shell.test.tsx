import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { SidebarProvider } from '@/app/shell/sidebar'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { SettingsView } from './settings-view'

function renderAt(path: string) {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <MemoryRouter initialEntries={[path]}>
            <SettingsView />
          </MemoryRouter>
        </SidebarProvider>
      </QueryClientProvider>
    </I18nProvider>
  )
}

describe('settings portal', () => {
  // Note: both the wide rail and the narrow tab-dropdown are always in the DOM
  // (the 47.5rem media query hides one, but stylesheets aren't loaded in jsdom),
  // so a given nav label can appear more than once — assert presence, not count.
  it('renders the desktop-style nav rail with all sections + a close control', () => {
    renderAt('/settings')
    expect(screen.getAllByRole('button', { name: 'Model' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Appearance' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'About' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeInTheDocument()
  })

  it('renders the requested section from the URL', () => {
    renderAt('/settings/about')
    expect(screen.getAllByRole('button', { name: 'About' }).length).toBeGreaterThan(0)
  })

  it('lists Keyboard shortcuts in the nav and answers desktop’s `keybinds` id', () => {
    renderAt('/settings/keybinds')
    // The nav entry itself: universal spells the id `shortcuts`, and the entry
    // was absent from the overlay rail entirely (titlebar-button only) until now.
    expect(screen.getAllByRole('button', { name: 'Keyboard shortcuts' }).length).toBeGreaterThan(0)
    // …and desktop's `keybinds` id resolves to the panel rather than falling
    // through to the default branch's empty state.
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeInTheDocument()
  })
})
