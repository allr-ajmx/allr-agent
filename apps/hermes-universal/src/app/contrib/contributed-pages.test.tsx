/**
 * A contributed `routes` page renders inside the workspace pane, behind a blast
 * wall, and joins the table WITHOUT remounting the core routes.
 */

import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ChatScreen pulls the whole chat graph (gateway, PTY, markdown). The catch-all
// route below only needs to be identifiable, not real.
vi.mock('@/app/chat/chat-screen', () => ({ ChatScreen: () => <div data-testid="chat" /> }))

import { ROUTES_AREA } from '@/app/routes'
import { registry } from '@/contrib/registry'

import { WorkspaceRoutes } from './panes'

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceRoutes />
    </MemoryRouter>
  )

const disposers: Array<() => void> = []

afterEach(() => {
  while (disposers.length) {
    disposers.pop()?.()
  }
})

describe('contributed pages', () => {
  it('renders a contributed page at its path', () => {
    disposers.push(
      registry.register({
        area: ROUTES_AREA,
        data: { path: '/kanban' },
        id: 'demo:kanban',
        render: () => <div data-testid="board">board</div>,
        source: 'plugin:demo'
      })
    )

    renderAt('/kanban')

    expect(screen.getByTestId('board')).toBeInTheDocument()
    // It is a page, so the drawer layout's zone body is marked headerless.
    expect(document.querySelector('[data-zone-no-header]')).toBeTruthy()
  })

  it('falls through to the chat catch-all when nothing is contributed', () => {
    renderAt('/kanban')

    expect(screen.getByTestId('chat')).toBeInTheDocument()
  })

  it('contains a throwing page instead of blanking the workspace', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    disposers.push(
      registry.register({
        area: ROUTES_AREA,
        data: { path: '/boom' },
        id: 'demo:boom',
        render: () => {
          throw new Error('plugin exploded')
        },
        source: 'plugin:demo'
      })
    )

    expect(() => renderAt('/boom')).not.toThrow()
    // The blast wall's pane fallback names the contribution.
    expect(screen.getByText(/failed to render/)).toBeInTheDocument()

    spy.mockRestore()
  })

  it('appends a late contribution without remounting the core route', () => {
    const { unmount } = renderAt('/')
    const chat = screen.getByTestId('chat')

    disposers.push(
      registry.register({
        area: ROUTES_AREA,
        data: { path: '/late' },
        id: 'demo:late',
        render: () => <div data-testid="late" />,
        source: 'plugin:demo'
      })
    )

    // Same DOM node: the core route table was not rebuilt underneath it.
    expect(screen.getByTestId('chat')).toBe(chat)

    unmount()
  })
})
