import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as PlatformModule from '@/lib/platform'
import { $panesFlipped, $rightSidebarOpen, $terminalOpen, setSidebarOpen } from '@/store/layout'
import { $reviewOpen } from '@/store/review'

// The titlebar-clearing inset is desktop-only chrome; jsdom reports no Tauri
// runtime, so force IS_DESKTOP while keeping the rest of the module real.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof PlatformModule>()),
  IS_DESKTOP: true
}))

import { seedActiveSession } from '@/test-sessions'

import { ChatHeader } from './chat-header'

const INSET = 'pl-[6.75rem]'

const renderHeader = () => {
  // ChatTitle (nested) calls useLocation, so a router context is required.
  const { container } = render(
    <MemoryRouter>
      <ChatHeader />
    </MemoryRouter>
  )

  return container.firstChild as HTMLElement
}

afterEach(() => {
  cleanup()
  seedActiveSession('draft', { runtimeSessionId: null, storedSessionId: null })
  $panesFlipped.set(false)
  $rightSidebarOpen.set(false)
  $reviewOpen.set(false)
  $terminalOpen.set(false)
  setSidebarOpen(true)
})

// The header is pulled up into the transparent titlebar band, so it must clear
// the sidebar/swap/search cluster exactly when NO pane occupies the left edge.
describe('ChatHeader — titlebar cluster inset', () => {
  it('hugs the pane edge while the chat sidebar holds the left side', () => {
    seedActiveSession('live-1')
    setSidebarOpen(true)

    expect(renderHeader().className).toContain('pl-3')
  })

  it('clears the cluster once the left side is empty', () => {
    seedActiveSession('live-1')
    setSidebarOpen(false)

    expect(renderHeader().className).toContain(INSET)
  })

  // The bug: flipped, the chat sidebar sits on the RIGHT, so an open sidebar no
  // longer keeps the chat off the window's left edge.
  it('clears the cluster when flipped with the left rails closed', () => {
    seedActiveSession('live-1')
    $panesFlipped.set(true)
    setSidebarOpen(true)
    $rightSidebarOpen.set(false)

    expect(renderHeader().className).toContain(INSET)
  })

  it('hugs the pane edge when flipped with the rails on the left', () => {
    seedActiveSession('live-1')
    $panesFlipped.set(true)
    $rightSidebarOpen.set(true)

    expect(renderHeader().className).toContain('pl-3')
  })

  it('hugs the pane edge when flipped with only the review pane on the left', () => {
    seedActiveSession('live-1')
    $panesFlipped.set(true)
    $rightSidebarOpen.set(false)
    $reviewOpen.set(true)

    expect(renderHeader().className).toContain('pl-3')
  })
})
