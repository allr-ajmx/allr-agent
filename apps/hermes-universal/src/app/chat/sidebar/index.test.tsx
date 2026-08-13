import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { $panesFlipped, setSidebarOpen } from '@/store/layout'

import { ChatSidebar, type ChatSidebarProps } from './index'

const renderSidebar = (props: ChatSidebarProps = {}) =>
  render(
    <MemoryRouter>
      <ChatSidebar {...props} />
    </MemoryRouter>
  )

afterEach(() => {
  setSidebarOpen(true)
  $panesFlipped.set(false)
})

describe('ChatSidebar (pane) — the sidebar↔main division', () => {
  it('paints the surface + edge border on the main-facing (inline-end) edge when open', () => {
    setSidebarOpen(true)
    const { container } = renderSidebar({ variant: 'pane' })
    const root = container.firstChild as HTMLElement

    expect(root.className).toContain('bg-(--ui-sidebar-surface-background)')
    expect(root.className).toContain('border-(--sidebar-edge-border)')
    // Whole token, not `toContain`: the unflipped class list also carries
    // `border-s-0`, so a substring check passes in BOTH states and can never
    // fail. (It could not fail on `border-r`/`border-l-0` either.)
    expect(root.className).toMatch(/(?:^|\s)border-e(?:\s|$)/)
    expect(screen.getByText('New session')).toBeInTheDocument()
  })

  it('goes transparent + non-interactive when closed (main shows through)', () => {
    setSidebarOpen(false)
    const { container } = renderSidebar({ variant: 'pane' })
    const root = container.firstChild as HTMLElement

    expect(root.className).toContain('bg-transparent')
    expect(root.className).toContain('opacity-0')
    expect(root.className).toContain('pointer-events-none')
  })

  it('mirrors the border to the inline-start edge when panes are flipped', () => {
    setSidebarOpen(true)
    $panesFlipped.set(true)
    const { container } = renderSidebar({ variant: 'pane' })
    const root = container.firstChild as HTMLElement

    expect(root.className).toMatch(/(?:^|\s)border-s(?:\s|$)/)
  })
})
