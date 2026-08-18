import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so these are erased and cannot trip vi.mock's hoisting.
import type * as ConnectionModule from '@/store/connection'
import type * as SshBackendModule from '@/store/ssh-backend'

// SSH mode landed on main AFTER this branch was cut, so its connect path never went
// through the soft switch. The merge rerouted it; these pin that down, because an
// SSH dial that bypassed runConnect would leave the previous gateway's session rows
// on screen for the 45-90s the tunnel takes to come up.

vi.mock('@/store/gateway-soft-switch', () => ({ softSwitchGateway: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/store/gateway-switch-broadcast', () => ({ broadcastGatewaySwitch: vi.fn() }))
vi.mock('@/lib/secure-store', () => ({
  // Resolves to a record, never null — the form prefill reads fields off it directly.
  loadSshSecrets: vi.fn().mockResolvedValue({}),
  mergeSshSecrets: vi.fn().mockResolvedValue(undefined),
  saveSecrets: vi.fn().mockResolvedValue(undefined),
  loadSecrets: vi.fn().mockResolvedValue(null)
}))
vi.mock('@/store/connection', async importActual => ({
  ...(await importActual<typeof ConnectionModule>()),
  connectSsh: vi.fn().mockResolvedValue(undefined),
  probeStatus: vi.fn().mockRejectedValue(new Error('no gateway in tests'))
}))
vi.mock('@/store/ssh-backend', async importActual => ({
  ...(await importActual<typeof SshBackendModule>()),
  newAttemptId: () => 'attempt-1',
  onSshHostKey: vi.fn().mockResolvedValue(() => {}),
  onSshProgress: vi.fn().mockResolvedValue(() => {}),
  onSshPrompt: vi.fn().mockResolvedValue(() => {}),
  testSshBackend: vi.fn().mockResolvedValue({ hostLabel: 'box', platform: 'linux' })
}))

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { connectSsh } from '@/store/connection'
import { saveGatewayTarget } from '@/store/gateway-restore'
import { softSwitchGateway } from '@/store/gateway-soft-switch'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'
import { testSshBackend } from '@/store/ssh-backend'

import { GatewayConfigurator } from './gateway-configurator'

function renderConfigurator() {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConfigurator variant="settings" />
      </QueryClientProvider>
    </I18nProvider>
  )
}

/** Pick the SSH mode card, type a host, and hit the commit button. */
function connectOverSsh(host = 'deploy@box') {
  fireEvent.click(screen.getByRole('button', { name: /^SSH/ }))
  fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: host } })
  fireEvent.click(screen.getByRole('button', { name: 'Save and reconnect' }))
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('GatewayConfigurator — SSH connect', () => {
  it('dials through the soft switch rather than straight to connectSsh', async () => {
    renderConfigurator()
    connectOverSsh()

    await waitFor(() => expect(softSwitchGateway).toHaveBeenCalledOnce())
    expect(vi.mocked(softSwitchGateway).mock.calls[0][0]).toBe('ssh')
  })

  it('hands the ssh dial to the switch as its thunk', async () => {
    renderConfigurator()
    connectOverSsh()

    await waitFor(() => expect(softSwitchGateway).toHaveBeenCalledOnce())

    // The switch owns when the dial runs — it wipes and closes the socket first.
    expect(connectSsh).not.toHaveBeenCalled()
    await vi.mocked(softSwitchGateway).mock.calls[0][1]()
    expect(connectSsh).toHaveBeenCalledOnce()
  })

  it('tells the other WebViews once the ssh switch has landed', async () => {
    saveGatewayTarget({ mode: 'ssh', profile: null, ssh: { host: 'deploy@box' } })
    renderConfigurator()
    connectOverSsh()

    await waitFor(() => expect(broadcastGatewaySwitch).toHaveBeenCalledOnce())
    expect(vi.mocked(broadcastGatewaySwitch).mock.calls[0][0]).toBe('ssh')
  })
})

describe('GatewayConfigurator — SSH test', () => {
  it('sends the credentials typed in the form, not the target alone', async () => {
    // The bug this pins down: Test sent only host/user/port/keyPath, so a
    // password or passphrase entered directly above the button never reached
    // Rust. Test therefore prompted for a credential the form was already
    // holding, and the one that was typed looked like it had been ignored. On
    // mobile it was worse — a pasted PEM is the only credential there is.
    const { container } = renderConfigurator()

    fireEvent.click(screen.getByRole('button', { name: /^SSH/ }))
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'deploy@box' } })
    fireEvent.change(screen.getByPlaceholderText('~/.ssh/id_ed25519'), { target: { value: '~/.ssh/work' } })

    // The panel's only masked rows, in order: key passphrase, then login
    // password. They are deliberately two fields — a login password typed into
    // the passphrase row does nothing at all.
    const [passphrase, password] = container.querySelectorAll('input[type="password"]')
    fireEvent.change(passphrase, { target: { value: 'unlock-the-key' } })
    fireEvent.change(password, { target: { value: 'login-secret' } })

    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    await waitFor(() => expect(testSshBackend).toHaveBeenCalledOnce())

    expect(vi.mocked(testSshBackend).mock.calls[0][1]).toMatchObject({
      host: 'deploy@box',
      interactive: true,
      keyPath: '~/.ssh/work',
      passphrase: 'unlock-the-key',
      password: 'login-secret'
    })
  })

  it('leaves an untouched secret row undefined rather than blank', async () => {
    // `Some("")` is not `None` in Rust: an empty passphrase makes russh attempt
    // a decrypt instead of reporting that the key needs one, which silently
    // discarded every encrypted key.
    renderConfigurator()

    fireEvent.click(screen.getByRole('button', { name: /^SSH/ }))
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'box' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test SSH' }))

    await waitFor(() => expect(testSshBackend).toHaveBeenCalledOnce())

    const config = vi.mocked(testSshBackend).mock.calls[0][1]
    expect(config.passphrase).toBeUndefined()
    expect(config.password).toBeUndefined()
    expect(config.privateKeyPem).toBeUndefined()
  })
})
