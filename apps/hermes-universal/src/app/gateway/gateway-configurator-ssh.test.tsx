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
vi.mock('@/store/gateway-switch-sync', () => ({ broadcastGatewaySwitch: vi.fn() }))
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
import { broadcastGatewaySwitch } from '@/store/gateway-switch-sync'

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
