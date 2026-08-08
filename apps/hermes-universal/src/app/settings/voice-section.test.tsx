import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The voice section renders only tts.elevenlabs.voice_id (config carries
// tts.provider='elevenlabs' so voiceFieldVisible keeps it). The key is in
// FREE_INPUT_KEYS, so with voices listed it becomes a ComboboxInput — a
// free-text field whose known voices are dropdown suggestions rather than a
// gate; without voices, the generic free-text Input.
vi.mock('@/hermes', () => ({
  // Via ConfigSection → store/projects → store/profile → store/profiles, which
  // syncs the REST scope at import time.
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({ tts: { provider: 'elevenlabs', elevenlabs: { voice_id: 'v1' } } })),
  getHermesConfigSchema: vi.fn(async () => ({ fields: { 'tts.elevenlabs.voice_id': { type: 'string' } } })),
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  getElevenLabsVoices: vi.fn()
}))

import { MemoryRouter } from 'react-router-dom'

import { getElevenLabsVoices } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { VoiceSection } from './voice-section'

const voices = vi.mocked(getElevenLabsVoices)

// Router context: the config section underneath reads ?field= for palette
// deep links.
function renderVoice() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <VoiceSection />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>
  )
}

describe('VoiceSection', () => {
  beforeEach(() => queryClient.clear())
  afterEach(() => {
    queryClient.clear()
    voices.mockReset()
  })

  it('renders a suggestion combobox when ElevenLabs voices are available', async () => {
    voices.mockResolvedValue({ available: true, voices: [{ voice_id: 'v1', name: 'rachel', label: 'Rachel' }] })
    renderVoice()

    // The voice field keeps its current value editable and offers the listed
    // voices behind the chevron — a custom voice id must stay typeable.
    await waitFor(() => expect(screen.getByDisplayValue('v1')).toBeInTheDocument())
    expect(screen.getByLabelText('Show options')).toBeInTheDocument()
  })

  it('falls back to a plain free-text field when voices cannot be listed', async () => {
    voices.mockResolvedValue({ available: false, voices: [] })
    renderVoice()

    expect(await screen.findByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByLabelText('Show options')).not.toBeInTheDocument()
  })
})
