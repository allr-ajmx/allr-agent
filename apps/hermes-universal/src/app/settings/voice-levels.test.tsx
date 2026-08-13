import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Handler = (event: unknown) => void
  const handlers = new Set<Handler>()

  const lease = {
    arm: vi.fn<(mode?: string) => Promise<void>>(async () => undefined),
    wakeListen: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    forceTurn: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    on(handler: Handler) {
      handlers.add(handler)

      return () => handlers.delete(handler)
    },
    closed: false
  }

  return {
    handlers,
    lease,
    emit: (event: unknown) => handlers.forEach(handler => handler(event)),
    open: vi.fn(async (_owner: string, _opts: unknown) => lease),
    pauseWake: vi.fn(async () => undefined),
    resumeWake: vi.fn(async () => undefined),
    notifyError: vi.fn(),
    record: { value: { voice: {} } as Record<string, unknown> },
    save: vi.fn(async () => ({ ok: true }))
  }
})

vi.mock('@/hermes', () => ({
  apiRequestProfile: () => null,
  // Reached via useOnProfileSwitch → store/profile → store/profiles, which syncs
  // the REST scope at import time.
  setApiRequestProfile: vi.fn(),
  getHermesConfigRecord: vi.fn(async () => h.record.value),
  saveHermesConfig: h.save
}))
vi.mock('@/voice/engine', () => ({ voiceEngine: { open: h.open, updateAuth: vi.fn(), owner: null } }))
vi.mock('@/store/wake-word', () => ({ pauseWakeForVoice: h.pauseWake, resumeWakeAfterVoice: h.resumeWake }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: h.notifyError }))

import { I18nProvider } from '@/i18n'
import { $voiceBargeinThreshold, $voiceInputGain, $voiceInputThreshold, $voiceOutputVolume } from '@/store/voice-prefs'

import { VoiceLevelsPanel } from './voice-levels'

function renderPanel() {
  return render(
    <I18nProvider>
      <VoiceLevelsPanel />
    </I18nProvider>
  )
}

const startMeter = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Test microphone/i }))
  await waitFor(() => expect(h.open).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  h.handlers.clear()
  h.record.value = { voice: {} }
  $voiceInputGain.set(3)
  $voiceInputThreshold.set(0.075)
  $voiceBargeinThreshold.set(0.16)
  $voiceOutputVolume.set(1)
})

afterEach(() => vi.clearAllMocks())

describe('voice levels panel', () => {
  it('renders every level from the store', () => {
    $voiceInputGain.set(4.5)
    $voiceInputThreshold.set(0.2)
    renderPanel()

    expect(screen.getByLabelText('Input gain')).toHaveValue('4.5')
    expect(screen.getByLabelText('Input threshold')).toHaveValue('0.2')
    expect(screen.getByLabelText('Barge-in threshold')).toHaveValue('0.16')
    expect(screen.getByLabelText('Speech volume')).toHaveValue('1')
  })

  it('persists a dragged slider under its voice.* key', async () => {
    renderPanel()

    fireEvent.change(screen.getByLabelText('Input threshold'), { target: { value: '0.25' } })

    await waitFor(() =>
      expect(h.save).toHaveBeenCalledWith(
        expect.objectContaining({ voice: expect.objectContaining({ input_threshold: 0.25 }) })
      )
    )
    expect($voiceInputThreshold.get()).toBe(0.25)
  })

  // The mic must not open just because the page rendered — only when the user
  // presses the button.
  it('opens no microphone until the user asks for one', () => {
    renderPanel()

    expect(h.open).not.toHaveBeenCalled()
  })

  // The whole reason a settings meter can exist: it arms `monitor`, which Rust
  // makes incapable of starting a turn — so the calibration pass never records
  // or transcribes the user.
  it('leases at meter priority and arms monitor, never a recording mode', async () => {
    renderPanel()
    await startMeter()

    expect(h.open).toHaveBeenCalledWith('meter', expect.objectContaining({ vad: { levelGain: 1 } }))
    await waitFor(() => expect(h.lease.arm).toHaveBeenCalledWith('monitor'))
    expect(h.lease.arm).not.toHaveBeenCalledWith('normal')
    expect(h.lease.arm).not.toHaveBeenCalledWith('bargein')
    // And no transcription target is handed over at all.
    expect(h.open.mock.calls[0][1]).toMatchObject({ target: { baseUrl: '' } })
  })

  // The session is opened at gain 1 and the gain applied here, so dragging the
  // slider moves the meter without reopening the device — and the number still
  // describes what a real conversation would see.
  it('scales the reported level by the input gain', async () => {
    renderPanel()
    await startMeter()

    h.emit({ type: 'level', level: 0.05 })
    await waitFor(() => expect(screen.getByText('Level 15%')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Input gain'), { target: { value: '6' } })
    await waitFor(() => expect(screen.getByText('Level 30%')).toBeInTheDocument())
  })

  it('holds the loudest level seen as a peak', async () => {
    renderPanel()
    await startMeter()

    h.emit({ type: 'level', level: 0.3 })
    h.emit({ type: 'level', level: 0.01 })

    await waitFor(() => expect(screen.getByText('Peak 90%')).toBeInTheDocument())
    expect(screen.getByText('Level 3%')).toBeInTheDocument()
  })

  it('releases the microphone on stop, and hands the wake listener back', async () => {
    renderPanel()
    await startMeter()
    expect(h.pauseWake).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Stop/i }))

    await waitFor(() => expect(h.lease.close).toHaveBeenCalled())
    await waitFor(() => expect(h.resumeWake).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /Test microphone/i })).toBeInTheDocument()
  })

  // Navigating away from Settings must not leave a hot microphone behind.
  it('releases the microphone when the page unmounts', async () => {
    const view = renderPanel()
    await startMeter()

    view.unmount()

    await waitFor(() => expect(h.lease.close).toHaveBeenCalled())
    await waitFor(() => expect(h.resumeWake).toHaveBeenCalled())
  })

  // A conversation preempts the meter (engine priority), which closes the lease
  // out from under us — the button has to come back rather than lie.
  it('resets when the session is closed underneath it', async () => {
    renderPanel()
    await startMeter()

    h.emit({ type: 'state', state: 'closed' })

    await waitFor(() => expect(screen.getByRole('button', { name: /Test microphone/i })).toBeInTheDocument())
  })

  it('reports a microphone it could not open instead of showing a dead meter', async () => {
    h.open.mockRejectedValueOnce(new Error('no_input_device'))
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /Test microphone/i }))

    await waitFor(() => expect(h.notifyError).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /Test microphone/i })).toBeInTheDocument()
    // The ear the meter took off the air goes straight back on.
    expect(h.resumeWake).toHaveBeenCalled()
  })
})
