import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Type-only, so these are erased and cannot trip vi.mock's hoisting.
import type * as ConnectionModule from '@/store/connection'
import type * as NotificationsModule from '@/store/notifications'

// Partial: only the sign-out itself (keyring, cookies, IPC) and the toast are stubbed.
vi.mock('@/store/connection', async importOriginal => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  signOut: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notify: vi.fn()
}))

import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { $allrWorkError, $allrWorkRestoreIssue } from '@/store/allr-work-state'
import { $connection, $connectionPhase } from '@/store/connection'
import { $gatewayMode } from '@/store/gateway-switch'
import { notify } from '@/store/notifications'

import { GatewayConfigurator } from './gateway-configurator'

function renderVariant(variant: 'embedded' | 'onboarding' | 'settings') {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <GatewayConfigurator variant={variant} />
      </QueryClientProvider>
    </I18nProvider>
  )
}

describe('GatewayConfigurator variants', () => {
  it('settings shows the page chrome: header + save-for-restart', () => {
    renderVariant('settings')
    expect(screen.getByText('Gateway Connection')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save for next restart' })).toBeInTheDocument()
  })

  // The embedded variant is hosted inside a popover / recovery card that owns its
  // own header and offers a single commit action.
  it('embedded drops the header and save-for-restart, keeps the connect surface', () => {
    renderVariant('embedded')
    expect(screen.queryByText('Gateway Connection')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save for next restart' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
  })

  it('embedded keeps the mode cards single-column at every window width', () => {
    const { container } = renderVariant('embedded')
    const grid = container.querySelector('.auto-rows-fr')
    // Every literal matters: the settings grid is 5-col where Local is offered
    // and 4-col where it is not, so only rejecting one would prove nothing.
    expect(grid?.className).not.toMatch(/grid-cols-[2-9]/)
  })

  it('settings keeps the multi-column grid it has the width for', () => {
    const { container } = renderVariant('settings')
    const grid = container.querySelector('.auto-rows-fr')
    // Which literal depends on LOCAL_MODE_SUPPORTED (five cards with Local, four
    // without); either proves settings did not get swept up in the narrow-host
    // single-column rule.
    expect(grid?.className).toMatch(/min-\[42rem\]:grid-cols-[45]/)
  })

  // The first-run local install flow belongs to the wizard alone. Settings and
  // the embedded recovery card are for a user who already HAS a working install
  // and wants to point back at it — replacing their connect button with a
  // detect-and-install screen would put a repo picker in front of someone who
  // only wanted to switch gateways.
  it.each(['embedded', 'settings'] as const)('%s keeps the plain local action bar', variant => {
    renderVariant(variant)
    expect(screen.queryByText('No local installation found')).not.toBeInTheDocument()
    expect(screen.queryByText('Looking for a local installation…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
  })

  // `onboarding` splits the grid and the panels into two wizard steps (see
  // app/connect-screen.tsx). These two must NOT: they are one-page surfaces, and
  // a leak would hide either the mode cards or the fields behind a step the host
  // has no control over.
  it.each(['embedded', 'settings'] as const)('%s shows the mode grid and the panel together', variant => {
    renderVariant(variant)
    expect(screen.getByText('Connection mode')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
    // The wizard's step header belongs to onboarding alone.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
  })
})

// The session belongs to ONE gateway. Reporting it against whatever URL is in the field
// is how "sign in to a different gateway" became unreachable from Settings: the pill said
// Signed in, and the button it replaced was the only way to start the sign-in.
describe('signed-in state is scoped to the connected gateway', () => {
  afterEach(() => {
    $connection.set(null)
    $connectionPhase.set('idle')
    localStorage.clear()
  })

  function connectedTo(liveUrl: string, fieldUrl: string) {
    localStorage.setItem('hermes.url', fieldUrl)
    $connection.set({ baseUrl: liveUrl, mode: 'remote', authMode: 'oauth' })
    $connectionPhase.set('ready')
    renderVariant('settings')
  }

  it('shows Signed in for the gateway actually connected', () => {
    connectedTo('https://gw.a', 'https://gw.a')
    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('offers Sign in once the field holds a different gateway', () => {
    connectedTo('https://gw.a', 'https://gw.b')
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})

// ALLR-51: Allr Work is the one mode with nothing to type, so it leads on every gateway surface —
// the first-run wizard, Settings ▸ Gateway, and the embedded popover / reconnect card.
describe('Allr Work card', () => {
  afterEach(() => {
    localStorage.clear()
  })

  const cards = (container: HTMLElement) => [...(container.querySelector('.auto-rows-fr')?.children ?? [])]

  it.each(['embedded', 'onboarding', 'settings'] as const)('Allr Work is the first mode card (%s)', variant => {
    const { container } = renderVariant(variant)
    const [first, ...rest] = cards(container)

    expect(first?.textContent).toMatch(/^Allr Work/)
    // Nous Cloud keeps its own card and name (ALLR-20: Nous branding here is deliberate).
    expect(rest.some(card => card.textContent?.startsWith('Nous Cloud'))).toBe(true)
  })

  it('titles the pending mode Allr Work, not Remote gateway', () => {
    renderVariant('onboarding')
    fireEvent.click(screen.getByRole('button', { name: /^Allr Work/ }))

    expect(screen.getByRole('heading', { name: 'Allr Work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in to Allr Work' })).toBeInTheDocument()
  })

  it.each(['embedded', 'onboarding', 'settings'] as const)(
    'selecting allr shows the panel and hides the action bar (%s)',
    variant => {
      const { container } = renderVariant(variant)

      expect(container.querySelector('[data-slot="allr-work-panel"]')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /^Allr Work/ }))

      expect(container.querySelector('[data-slot="allr-work-panel"]')).not.toBeNull()
      expect(screen.getByRole('button', { name: 'Sign in to Allr Work' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Save and reconnect' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Save for next restart' })).not.toBeInTheDocument()
    }
  )
})

// ALLR-51 B1. A mobile resume that really failed — or a failed first connect with nothing to
// roll back to — lands on the first-run wizard. Its 'select' step would hide why.
describe('onboarding opens on the Allr Work step when the card has something to say', () => {
  afterEach(() => {
    $allrWorkError.set(null)
    $allrWorkRestoreIssue.set(null)
    $gatewayMode.set('remote')
    localStorage.clear()
  })

  it('at mount, for a sign-in failure', () => {
    $gatewayMode.set('allr')
    $allrWorkError.set({ kind: 'workspace-unsupported', message: 'Too old.' })
    renderVariant('onboarding')

    expect(screen.queryByText('Choose a gateway')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Allr Work' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Your workspace doesn’t support app sign-in yet.')
  })

  it('at mount, for a restore that gave up', () => {
    $gatewayMode.set('allr')
    $allrWorkRestoreIssue.set('session-ended')
    renderVariant('onboarding')

    expect(screen.getByText('Your Allr Work session ended. Sign in again to reconnect.')).toBeInTheDocument()
  })

  it('after mount, when the notice arrives while the wizard is choosing', async () => {
    $gatewayMode.set('allr')
    renderVariant('onboarding')
    expect(screen.getByText('Choose a gateway')).toBeInTheDocument()

    act(() => $allrWorkRestoreIssue.set('unreachable'))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument())
    expect(screen.queryByText('Choose a gateway')).not.toBeInTheDocument()
  })

  it('still lets the user go Back and choose another gateway', () => {
    $gatewayMode.set('allr')
    $allrWorkRestoreIssue.set('session-ended')
    renderVariant('onboarding')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getByText('Choose a gateway')).toBeInTheDocument()
  })

  it('leaves the wizard alone when the app is not on Allr Work', () => {
    $allrWorkError.set({ kind: 'timed-out', message: 'Slow.' })
    renderVariant('onboarding')

    expect(screen.getByText('Choose a gateway')).toBeInTheDocument()
  })
})

// ALLR-51 S3: the sign-out toast names what was signed out of.
describe('sign-out toast', () => {
  afterEach(() => {
    $connection.set(null)
    $connectionPhase.set('idle')
    $gatewayMode.set('remote')
    vi.mocked(notify).mockClear()
    localStorage.clear()
  })

  it('says Allr Work for the Allr Work card', async () => {
    $gatewayMode.set('allr')
    $connection.set({ baseUrl: 'https://xm.allr.work', mode: 'allr', authMode: 'oauth' })
    $connectionPhase.set('ready')
    renderVariant('settings')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Signed out of Allr Work on this device.' })
      )
    )
  })

  it('keeps the remote wording for a remote gateway', async () => {
    localStorage.setItem('hermes.url', 'https://gw.a')
    $connection.set({ baseUrl: 'https://gw.a', mode: 'remote', authMode: 'oauth' })
    $connectionPhase.set('ready')
    renderVariant('settings')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Cleared the remote gateway session.' }))
    )
  })
})
