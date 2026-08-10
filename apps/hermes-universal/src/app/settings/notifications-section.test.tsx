import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $completionSoundVariantId, DEFAULT_COMPLETION_SOUND_VARIANT_ID } from '@/store/completion-sound'
import { $nativeNotifyPrefs } from '@/store/native-notifications'

import { NotificationsSection } from './notifications-section'

const DEFAULTS = {
  enabled: true,
  kinds: {
    approval: true,
    backgroundDone: true,
    credits: true,
    input: true,
    plugin: true,
    turnDone: true,
    turnError: true
  }
}

function renderSection() {
  return render(
    <I18nProvider>
      <NotificationsSection />
    </I18nProvider>
  )
}

describe('NotificationsSection', () => {
  beforeEach(() => {
    localStorage.clear()
    $nativeNotifyPrefs.set({ ...DEFAULTS, kinds: { ...DEFAULTS.kinds } })
    $completionSoundVariantId.set(DEFAULT_COMPLETION_SOUND_VARIANT_ID)
  })
  afterEach(() => localStorage.clear())

  it('renders the master switch + a switch per kind + the haptics toggle', () => {
    renderSection()
    expect(screen.getByText('Enable notifications')).toBeInTheDocument()
    // master + 7 kinds + haptics = 9 switches (haptics row shows off-desktop, and
    // vitest is a non-Tauri host so IS_DESKTOP is false)
    expect(screen.getAllByRole('switch')).toHaveLength(9)
  })

  it('toggles the master enabled flag through the store', () => {
    renderSection()
    const master = screen.getAllByRole('switch')[0]
    fireEvent.click(master)
    expect($nativeNotifyPrefs.get().enabled).toBe(false)
  })

  it('renders the completion-sound picker and updates the variant on select', () => {
    renderSection()
    // The completion-sound Select renders as a combobox showing the default preset.
    const picker = screen.getByRole('combobox')
    expect(picker).toBeInTheDocument()
    expect(screen.getByText('Completion Sound')).toBeInTheDocument()

    // Opening the listbox and choosing another preset persists the new variant id.
    fireEvent.click(picker)
    fireEvent.click(screen.getByRole('option', { name: 'Glass ping' }))
    expect($completionSoundVariantId.get()).toBe(2)
  })
})
