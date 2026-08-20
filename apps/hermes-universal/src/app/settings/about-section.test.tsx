import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '1.2.3') }))

const checkAppUpdate = vi.fn()
const openAppDownload = vi.fn<(url: string, fallback?: null | string) => Promise<void>>()
const installAppUpdate = vi.fn<() => Promise<void>>()

vi.mock('@/lib/updates', () => ({
  checkAppUpdate: (force: boolean) => checkAppUpdate(force),
  installAppUpdate: () => installAppUpdate(),
  openAppDownload: (url: string, fallback?: null | string) => openAppDownload(url, fallback)
}))

import { I18nProvider } from '@/i18n'
import { __resetUpdateState } from '@/store/updates'

import { AboutSection } from './about-section'

function renderAbout() {
  return render(
    <I18nProvider>
      <AboutSection />
    </I18nProvider>
  )
}

// A store-backed status (mobile): the app cannot install this itself, so the
// UI may only open the listing.
const AVAILABLE = {
  source: 'play',
  currentVersion: '1.2.3',
  latestVersion: '1.3.0',
  updateAvailable: true,
  downloadUrl: 'https://example.test/Hermes_1.3.0.AppImage',
  notesUrl: 'https://example.test/release',
  checkedAtMs: Date.now(),
  reason: null,
  canSelfInstall: false
}

// The desktop updater: it installs in place, so there is nothing to open and
// `downloadUrl` is deliberately null.
const SELF_INSTALL = {
  ...AVAILABLE,
  source: 'updater',
  downloadUrl: null,
  canSelfInstall: true
}

describe('AboutSection', () => {
  beforeEach(() => {
    __resetUpdateState()
    checkAppUpdate.mockReset()
    openAppDownload.mockClear()
    installAppUpdate.mockReset()
    installAppUpdate.mockResolvedValue(undefined)
    checkAppUpdate.mockResolvedValue(null)
  })

  it('shows the app version and a release-notes link', async () => {
    renderAbout()

    expect(await screen.findByText('Version 1.2.3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Release notes' })).toBeInTheDocument()
  })

  it('hides the update block in a build without update checks', async () => {
    checkAppUpdate.mockResolvedValue({
      source: 'disabled',
      currentVersion: '1.2.3',
      latestVersion: null,
      updateAvailable: false,
      downloadUrl: null,
      notesUrl: null,
      checkedAtMs: Date.now(),
      reason: 'checks_disabled'
    })

    renderAbout()

    expect(await screen.findByText('Version 1.2.3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Check now/ })).not.toBeInTheDocument()
  })

  it('offers a download when a newer version is published', async () => {
    checkAppUpdate.mockResolvedValue(AVAILABLE)

    renderAbout()

    expect(await screen.findByText('Version 1.3.0 is available.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Download/ }))

    expect(openAppDownload).toHaveBeenCalledWith(AVAILABLE.downloadUrl, AVAILABLE.notesUrl)
  })

  it('says it is on the latest when nothing is newer', async () => {
    checkAppUpdate.mockResolvedValue({ ...AVAILABLE, latestVersion: '1.2.3', updateAvailable: false })

    renderAbout()

    expect(await screen.findByText("You're on the latest version.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Download$/ })).not.toBeInTheDocument()
  })

  it('installs in place instead of downloading when the app can self-update', async () => {
    checkAppUpdate.mockResolvedValue(SELF_INSTALL)

    renderAbout()

    expect(await screen.findByText('Version 1.3.0 is available.')).toBeInTheDocument()
    // The download affordance is wrong here — there is no file to hand over.
    expect(screen.queryByRole('button', { name: /^Download$/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update now/ }))

    expect(installAppUpdate).toHaveBeenCalled()
    expect(openAppDownload).not.toHaveBeenCalled()
  })

  it('surfaces a failed install rather than silently doing nothing', async () => {
    checkAppUpdate.mockResolvedValue(SELF_INSTALL)
    installAppUpdate.mockRejectedValue(new Error('signature mismatch'))

    renderAbout()

    expect(await screen.findByText('Version 1.3.0 is available.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update now/ }))

    expect(await screen.findByText(/couldn't be installed/)).toBeInTheDocument()
  })

  it('reports an unreachable store without breaking the page', async () => {
    checkAppUpdate.mockResolvedValue({ ...AVAILABLE, updateAvailable: false, reason: 'unreachable' })

    renderAbout()

    expect(await screen.findByText("We couldn't reach the update server.")).toBeInTheDocument()
  })
})
