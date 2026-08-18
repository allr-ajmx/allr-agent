import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { I18nProvider } from '@/i18n'
import { $localInstall, applyInstallEvent, type InstallEvent, resetLocalInstall } from '@/store/local-install'

import { LocalInstallPanel } from './local-install-panel'

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

const onContinue = vi.fn()

function renderPanel() {
  return render(
    <I18nProvider>
      <LocalInstallPanel onContinue={onContinue} />
    </I18nProvider>
  )
}

/** Push events through the real reducer, as Rust would. */
function emit(...events: InstallEvent[]) {
  for (const event of events) {
    $localInstall.set(applyInstallEvent($localInstall.get(), event))
  }
}

const detected = (kind: string, extra: Record<string, unknown> = {}) => ({
  command: null,
  hasMarker: false,
  kind,
  root: null,
  version: null,
  ...extra
})

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  listenMock.mockResolvedValue(() => {})
  onContinue.mockReset()
  resetLocalInstall()
})

describe('when Allr is already installed', () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(
      detected('path', { command: '/usr/local/bin/allr', version: 'hermes 1.4.0' })
    )
  })

  it('shows the install and offers Continue', async () => {
    renderPanel()

    expect(await screen.findByText('Allr is installed')).toBeInTheDocument()
    expect(screen.getByText('/usr/local/bin/allr')).toBeInTheDocument()
    expect(screen.getByText('Version hermes 1.4.0')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalled()
  })

  it('does not offer to install anything', async () => {
    renderPanel()
    await screen.findByText('Allr is installed')

    // The found state is Continue-only: offering a reinstall here is how a
    // working install gets clobbered by accident.
    expect(screen.queryByText('NousResearch Hermes Agent')).not.toBeInTheDocument() // rebrand:keep — names the upstream project, not ours
    expect(screen.queryByText('MJX Fork of Hermes Agent')).not.toBeInTheDocument() // rebrand:keep — names the upstream project, not ours
  })
})

describe('when nothing is installed', () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(detected('none'))
  })

  it('says so and offers both repos', async () => {
    renderPanel()

    expect(await screen.findByText('No local installation found')).toBeInTheDocument()
    expect(screen.getByText('NousResearch Hermes Agent')).toBeInTheDocument() // rebrand:keep — names the upstream project, not ours
    expect(screen.getByText('MJX Fork of Hermes Agent')).toBeInTheDocument() // rebrand:keep — names the upstream project, not ours
  })

  it('describes the fork when it is picked', async () => {
    renderPanel()
    await screen.findByText('No local installation found')

    fireEvent.click(screen.getByText('MJX Fork of Hermes Agent')) // rebrand:keep — names the upstream project, not ours

    expect(
      await screen.findByText('A fork of Hermes Agent built for testing experimental features in Hermes Agent.') // rebrand:keep — names the upstream project, not ours
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument()
  })

  it('describes upstream when it is picked', async () => {
    renderPanel()
    await screen.findByText('No local installation found')

    fireEvent.click(screen.getByText('NousResearch Hermes Agent')) // rebrand:keep — names the upstream project, not ours

    expect(await screen.findByText('The official Hermes Agent from NousResearch.')).toBeInTheDocument() // rebrand:keep — names the upstream project, not ours
  })

  it('renders no Back of its own — the wizard header owns the only one', async () => {
    renderPanel()
    await screen.findByText('No local installation found')

    fireEvent.click(screen.getByText('MJX Fork of Hermes Agent')) // rebrand:keep — names the upstream project, not ours
    await screen.findByRole('button', { name: 'Install' })

    // A second Back stacked under the header's is what this replaced; the
    // header delegates to `stepBackInLocalInstall` instead.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
  })
})

describe('during and after an install', () => {
  beforeEach(() => {
    invokeMock.mockResolvedValue(detected('none'))
  })

  it('renders the stage ladder with the installer’s own titles', async () => {
    renderPanel()
    await screen.findByText('No local installation found')

    emit({
      protocolVersion: 1,
      stages: [
        { name: 'prerequisites', title: 'System prerequisites' },
        { name: 'repository', title: 'Download Allr' }
      ],
      type: 'manifest'
    })

    // Titles come from the manifest — not from our locale files.
    expect(await screen.findByText('System prerequisites')).toBeInTheDocument()
    expect(screen.getByText('Download Allr')).toBeInTheDocument()
    expect(screen.getByText('0 of 2 steps complete')).toBeInTheDocument()
  })

  it('shows the failure with the log already open', async () => {
    renderPanel()
    await screen.findByText('No local installation found')

    emit(
      { protocolVersion: 1, stages: [{ name: 'venv', title: 'Create venv' }], type: 'manifest' },
      { line: 'python not found', stream: 'stderr', type: 'log' },
      { error: 'the venv step failed', stage: 'venv', type: 'failed' }
    )

    expect(await screen.findByText('Installation failed')).toBeInTheDocument()
    expect(screen.getByText('the venv step failed')).toBeInTheDocument()
    // A failure is the one time the log matters more than the summary.
    await waitFor(() => expect(screen.getByText('python not found')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('offers Done on the placeholder setup screen', async () => {
    renderPanel()
    await screen.findByText('No local installation found')

    emit(
      { protocolVersion: 1, stages: [{ name: 'venv', title: 'Create venv' }], type: 'manifest' },
      { installRoot: '/home/u/.allr/allr-agent', type: 'complete' }
    )

    expect(await screen.findByText('Allr is ready')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onContinue).toHaveBeenCalled()
  })

  it('cancels the run that is actually in flight', async () => {
    // Driven through the real start path, not the reducer: cancel targets the
    // live install id, and a test that skipped `startLocalInstall` would assert
    // nothing. `local_install_start` stays pending, as it does in reality —
    // it only resolves when the whole install finishes.
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'local_install_detect') {
        return detected('none')
      }

      if (command === 'local_install_start') {
        return new Promise(() => {})
      }

      return undefined
    })

    renderPanel()
    await screen.findByText('No local installation found')

    fireEvent.click(screen.getByText('MJX Fork of Hermes Agent')) // rebrand:keep — names the upstream project, not ours
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    const start = await waitFor(() => {
      const call = invokeMock.mock.calls.find(([command]) => command === 'local_install_start')

      expect(call).toBeDefined()

      return call
    })

    emit({ protocolVersion: 1, stages: [{ name: 'venv', title: 'Create venv' }], type: 'manifest' })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel install' }))

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('local_install_cancel', {
        installId: (start?.[1] as { installId: string }).installId
      })
    )
  })
})
