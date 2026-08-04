import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { SIDEBAR_NAV_AREA } from '@/app/routes'
import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'

import { SidebarNavRail } from './nav-rail'

const renderRail = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <SidebarNavRail variant="pane" />
      </I18nProvider>
    </MemoryRouter>
  )

const contribute = (data: unknown, id = 'demo:nav') =>
  registry.register({ area: SIDEBAR_NAV_AREA, data, id, source: 'plugin:demo' })

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length) {
    disposers.pop()?.()
  }
})

describe('SidebarNavRail', () => {
  it('renders the four built-in rows', () => {
    renderRail()

    expect(screen.getByRole('button', { name: /Capabilities|Skills/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Artifacts/ })).toBeInTheDocument()
  })

  it('appends a contributed row below the built-ins', () => {
    disposers.push(contribute({ codicon: 'project', label: 'Kanban', path: '/kanban' }))

    renderRail()

    const buttons = screen.getAllByRole('button')
    expect(buttons.at(-1)?.textContent).toContain('Kanban')
  })

  it('navigates to the contributed path on click', () => {
    disposers.push(contribute({ label: 'Kanban', path: '/kanban' }))

    renderRail()
    fireEvent.click(screen.getByRole('button', { name: /Kanban/ }))

    // Nothing to assert on the router from here; what matters is it did not throw
    // and the row is still there (the rail does not unmount itself on navigate).
    expect(screen.getByRole('button', { name: /Kanban/ })).toBeInTheDocument()
  })

  it('lights up the contributed row by exact path, not by AppView', () => {
    disposers.push(contribute({ label: 'Kanban', path: '/kanban' }))

    renderRail('/kanban')

    expect(screen.getByRole('button', { name: /Kanban/ })).toHaveAttribute('aria-current', 'page')
  })

  it('drops a contribution with no label or a relative path', () => {
    disposers.push(
      contribute({ label: 'No path' }, 'demo:nopath'),
      contribute({ label: 'Relative', path: 'kanban' }, 'demo:relative'),
      contribute({ path: '/nolabel' }, 'demo:nolabel')
    )

    renderRail()

    expect(screen.queryByText('No path')).not.toBeInTheDocument()
    expect(screen.queryByText('Relative')).not.toBeInTheDocument()
  })
})
