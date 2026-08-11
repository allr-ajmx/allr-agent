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

import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { setActiveProfile } from '@/store/profiles'

import { ConfigSection } from './config-section'
import { getNested } from './helpers'

const save = vi.mocked(saveHermesConfig)

function renderSection(sectionId = 'chat') {
  // Router context: the section reads ?field= for palette deep links.
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <ConfigSection sectionId={sectionId} />
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
    setActiveProfile(null)
  })
  afterEach(() => {
    queryClient.clear()
    setActiveProfile(null)
  })

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

  // The panel stays mounted across a profile switch and `saveHermesConfig`
  // REPLACES the whole record, so an un-reset draft doesn't merge into the new
  // profile — it overwrites it with the previous profile's config wholesale.
  it('drops the draft on a profile switch instead of autosaving it into the new profile', async () => {
    renderSection()
    const toggle = await screen.findByRole('switch')

    fireEvent.click(toggle)
    expect(toggle).toBeChecked()

    // Profile B's config: the same key, still off.
    vi.mocked(getHermesConfigRecord).mockResolvedValue({ display: { show_reasoning: false }, timezone: 'Asia/Tokyo' })

    await act(async () => {
      setActiveProfile('b')
    })

    // Re-seeded from B, so the edit made against A is gone…
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
    // …and the debounced autosave it scheduled never reaches B.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps a declared row the backend schema omits, inferring its type from config', async () => {
    // `memory.provider` is the live case: the backend hides it from
    // /api/config/schema on deployments where the web dashboard's Plugins page
    // owns memory providers. The row (and the panel mounted under it) must stay.
    vi.mocked(getHermesConfigRecord).mockResolvedValue({ memory: { memory_enabled: true, provider: 'honcho' } })

    renderSection('memory')

    expect(await screen.findByDisplayValue('honcho')).toBeInTheDocument()
  })
})
