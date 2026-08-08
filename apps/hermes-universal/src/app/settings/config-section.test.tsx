import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hermes', () => ({
  // ConfigSection reaches `store/projects` (repository discovery), which pulls in
  // `store/profile` → `store/profiles`, and that syncs the REST scope at import.
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({ display: { show_reasoning: false }, timezone: 'UTC' })),
  getHermesConfigSchema: vi.fn(async () => ({
    fields: {
      'display.show_reasoning': { type: 'boolean' },
      timezone: { type: 'string' }
    }
  })),
  saveHermesConfig: vi.fn(async () => ({ ok: true }))
}))

import { MemoryRouter } from 'react-router-dom'

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { ConfigSection } from './config-section'
import { getNested } from './helpers'

const save = vi.mocked(saveHermesConfig)

function renderSection() {
  // Router context: the section reads ?field= for palette deep links.
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <ConfigSection sectionId="chat" />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('ConfigSection', () => {
  beforeEach(() => {
    save.mockClear()
    vi.mocked(getHermesConfigRecord).mockClear()
    queryClient.clear()
  })
  afterEach(() => queryClient.clear())

  it('renders the section schema fields once config + schema load', async () => {
    renderSection()
    expect(await screen.findByRole('switch')).toBeInTheDocument()
  })

  it('edits a field and autosaves the full record after the debounce', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch')

    fireEvent.click(toggle)

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 1500 })
    // The whole record is saved (not a partial), with the edited field flipped
    // and the untouched field preserved.
    const saved = save.mock.calls[0][0]
    expect(getNested(saved, 'display.show_reasoning')).toBe(true)
    expect(getNested(saved, 'timezone')).toBe('UTC')
  })
})
