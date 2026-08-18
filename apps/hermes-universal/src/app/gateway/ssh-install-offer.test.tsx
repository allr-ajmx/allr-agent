import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/store/installation-id', () => ({ getInstallationId: vi.fn().mockResolvedValue('a'.repeat(32)) }))
vi.mock('@/lib/secure-store', () => ({
  loadSshSecrets: vi.fn().mockResolvedValue({ passphrase: undefined, password: undefined, privateKeyPem: undefined })
}))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { I18nProvider } from '@/i18n'
import { applyInstallEvent, type InstallEvent } from '@/store/local-install'
import { $sshInstall, offerSshInstall, resetSshInstall } from '@/store/ssh-install'

import { SshInstallOffer } from './ssh-install-offer'

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

const target = { host: 'box.example.com', user: 'me' } as never

function renderOffer() {
  return render(
    <I18nProvider>
      <SshInstallOffer target={target} />
    </I18nProvider>
  )
}

function emit(...events: InstallEvent[]) {
  for (const event of events) {
    const current = $sshInstall.get()

    if (current) {
      $sshInstall.set({ ...applyInstallEvent(current, event), host: current.host })
    }
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  listenMock.mockResolvedValue(() => {})
  resetSshInstall()
})

describe('before anything has failed', () => {
  it('renders nothing at all', () => {
    const { container } = renderOffer()

    // The offer must never appear on a healthy SSH form — it is a response to a
    // specific failure, not a standing option.
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the offer', () => {
  beforeEach(() => offerSshInstall('box.example.com'))

  it('names the host and both repos', () => {
    renderOffer()

    expect(screen.getByText('Install Hermes on box.example.com?')).toBeInTheDocument()
    expect(screen.getByText('NousResearch Hermes Agent')).toBeInTheDocument()
    expect(screen.getByText('MJX Fork of Hermes Agent')).toBeInTheDocument()
  })

  it('says no administrator access is needed', () => {
    renderOffer()

    // The first question anyone asks about running an installer on their server.
    expect(screen.getByText(/No administrator access is needed/)).toBeInTheDocument()
  })

  it('installs nothing until a repo is picked and Install is pressed', async () => {
    renderOffer()

    fireEvent.click(screen.getByText('MJX Fork of Hermes Agent'))

    expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument()
    expect(
      screen.getByText('A fork of Hermes Agent built for testing experimental features in Hermes Agent.')
    ).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('ssh_install', expect.anything())
  })

  it('backs out of the repo description without installing', async () => {
    renderOffer()

    fireEvent.click(screen.getByText('MJX Fork of Hermes Agent'))
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))

    expect(await screen.findByText('Install Hermes on box.example.com?')).toBeInTheDocument()
    expect(invokeMock).not.toHaveBeenCalledWith('ssh_install', expect.anything())
  })

  it('dismisses entirely on Not now', () => {
    renderOffer()

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))

    expect($sshInstall.get()).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('while installing', () => {
  beforeEach(() => offerSshInstall('box.example.com'))

  it('shows the shared ladder with the installer’s own stage titles', async () => {
    renderOffer()
    emit({
      protocolVersion: 1,
      stages: [
        { name: 'prerequisites', title: 'System prerequisites' },
        { name: 'node-deps', title: 'Install browser-tool dependencies' }
      ],
      type: 'manifest'
    })

    expect(await screen.findByText('System prerequisites')).toBeInTheDocument()
    expect(screen.getByText('Install browser-tool dependencies')).toBeInTheDocument()
    expect(screen.getByText('0 of 2 steps complete')).toBeInTheDocument()
  })

  it('shows a failure with the remote reason and a retry', async () => {
    renderOffer()
    emit(
      { protocolVersion: 1, stages: [{ name: 'venv', title: 'Create venv' }], type: 'manifest' },
      { error: 'no python on that host', stage: 'venv', type: 'failed' }
    )

    expect(await screen.findByText('Installation failed')).toBeInTheDocument()
    expect(screen.getByText('no python on that host')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('tells the user to reconnect rather than connecting for them', async () => {
    renderOffer()
    emit(
      { protocolVersion: 1, stages: [{ name: 'venv', title: 'Create venv' }], type: 'manifest' },
      { installRoot: '/home/me/.hermes/hermes-agent', type: 'complete' }
    )

    expect(await screen.findByText('Hermes is installed on that host')).toBeInTheDocument()
    expect(screen.getByText('Press Save and reconnect to connect to it.')).toBeInTheDocument()
    // Installing is not dialling; the connect stays a separate deliberate act.
    expect(invokeMock).not.toHaveBeenCalledWith('ssh_connect', expect.anything())
  })
})
