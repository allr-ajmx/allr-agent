import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

const session = (over: Partial<SessionInfo>): SessionInfo =>
  ({
    id: 'x',
    title: null,
    preview: null,
    message_count: 0,
    ended_at: null,
    input_tokens: 0,
    archived: true,
    ...over
  }) as SessionInfo

vi.mock('@/hermes', () => ({
  listSessions: vi.fn(async () => ({
    sessions: [
      session({ id: 's1', title: 'Old chat', message_count: 3 }),
      session({ id: 's2', title: 'Another', message_count: 1 })
    ],
    total: 2,
    offset: 0
  })),
  setSessionArchived: vi.fn(async () => ({ ok: true })),
  deleteSession: vi.fn(async () => ({ ok: true })),
  getDefaultCwd: vi.fn(async () => ({ cwd: '/home/u', branch: null }))
}))
vi.mock('@/store/session', () => ({ refreshSessions: vi.fn(async () => undefined) }))
vi.mock('@/store/projects', () => ({ pickProjectFolder: vi.fn(async () => null) }))

import { MemoryRouter } from 'react-router-dom'

import { setSessionArchived } from '@/hermes'
import { I18nProvider } from '@/i18n'

import { ArchivedSection } from './archived-section'

const unarchive = vi.mocked(setSessionArchived)

// Router context: the section reads ?session= for palette deep links.
const renderSection = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <ArchivedSection />
      </I18nProvider>
    </MemoryRouter>
  )

describe('ArchivedSection', () => {
  beforeEach(() => unarchive.mockClear())
  afterEach(() => localStorage.clear())

  it('lists archived sessions', async () => {
    renderSection()
    expect(await screen.findByText('Old chat')).toBeInTheDocument()
    expect(screen.getByText('Another')).toBeInTheDocument()
  })

  it('unarchives a session and removes it from the list', async () => {
    renderSection()
    await screen.findByText('Old chat')
    fireEvent.click(screen.getAllByRole('button', { name: 'Unarchive' })[0])
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith('s1', false))
    await waitFor(() => expect(screen.queryByText('Old chat')).not.toBeInTheDocument())
  })
})
