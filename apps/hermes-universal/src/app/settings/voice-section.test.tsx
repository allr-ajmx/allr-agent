import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The voice section renders only tts.elevenlabs.voice_id (config carries
// tts.provider='elevenlabs' so voiceFieldVisible keeps it). With voices listed it
// becomes a Select (combobox); without, the generic free-text Input (textbox).
vi.mock('@/hermes', () => ({
  // Via ConfigSection → store/projects → store/profile → store/profiles, which
  // syncs the REST scope at import time.
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => ({ tts: { provider: 'elevenlabs', elevenlabs: { voice_id: 'v1' } } })),
  getHermesConfigSchema: vi.fn(async () => ({ fields: { 'tts.elevenlabs.voice_id': { type: 'string' } } })),
  saveHermesConfig: vi.fn(async () => ({ ok: true })),
  getElevenLabsVoices: vi.fn()
}))

import { getElevenLabsVoices } from '@/hermes'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'

import { VoiceSection } from './voice-section'

const voices = vi.mocked(getElevenLabsVoices)

function renderVoice() {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <VoiceSection />
      </QueryClientProvider>
    </I18nProvider>
  )
}

describe('VoiceSection', () => {
  beforeEach(() => queryClient.clear())
  afterEach(() => {
    queryClient.clear()
    voices.mockReset()
  })

  it('renders a voice dropdown when ElevenLabs voices are available', async () => {
    voices.mockResolvedValue({ available: true, voices: [{ voice_id: 'v1', name: 'rachel', label: 'Rachel' }] })
    renderVoice()

    // The voice field resolves to a Select (combobox) — not a free-text Input.
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument())
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('falls back to a free-text field when voices cannot be listed', async () => {
    voices.mockResolvedValue({ available: false, voices: [] })
    renderVoice()

    expect(await screen.findByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
