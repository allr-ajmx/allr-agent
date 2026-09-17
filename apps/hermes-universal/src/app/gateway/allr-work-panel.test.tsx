import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Type-only, so these are erased and cannot trip vi.mock's hoisting.
import type * as AllrWorkLib from '@/lib/allr-work'
import type * as AuthModule from '@/lib/auth'
import type * as ConnectionModule from '@/store/connection'
import type * as NotificationsModule from '@/store/notifications'

// The panel drives the REAL store (store/allr-work.ts). Only the edges are stubbed: the Rust
// commands, the gateway logout, the socket dial and the toast.
vi.mock('@/lib/allr-work', async importOriginal => ({
  ...(await importOriginal<typeof AllrWorkLib>()),
  allrWorkConfig: vi.fn().mockResolvedValue({ portalUrl: 'https://app.allr.work', parentDomain: 'allr.work' }),
  allrWorkClearSession: vi.fn().mockResolvedValue({ cleared: 1, supported: true }),
  allrWorkSignIn: vi.fn().mockResolvedValue({ busy: false, workspace: 'https://xm.allr.work' }),
  allrWorkTakeOutcome: vi.fn().mockResolvedValue(null)
}))
vi.mock('@/lib/auth', async importOriginal => ({
  ...(await importOriginal<typeof AuthModule>()),
  oauthLogout: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/store/connection', async importOriginal => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  connect: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  notifyError: vi.fn()
}))

import { I18nProvider } from '@/i18n'
import {
  ALLR_WORK_ERROR_KINDS,
  allrWorkClearSession,
  type AllrWorkErrorKind,
  AllrWorkInvokeError,
  allrWorkSignIn
} from '@/lib/allr-work'
import { oauthLogout } from '@/lib/auth'
import { $allrWorkError, $allrWorkRestoreIssue, $allrWorkSignInFlight } from '@/store/allr-work'
import { $connection, $connectionPhase, connect } from '@/store/connection'
import { saveGatewayTarget } from '@/store/gateway-restore'
import { notifyError } from '@/store/notifications'

import { AllrWorkPanel } from './allr-work-panel'

const WORKSPACE = 'https://xm.allr.work'

type RunConnect = (dial: () => Promise<void>) => Promise<void>

function renderPanel({
  onSignOut = vi.fn().mockResolvedValue(undefined),
  runConnect = (dial: () => Promise<void>) => dial()
}: { onSignOut?: () => Promise<void>; runConnect?: RunConnect } = {}) {
  const run = vi.fn(runConnect)

  render(
    <I18nProvider>
      <AllrWorkPanel onSignOut={onSignOut} runConnect={run} />
    </I18nProvider>
  )

  return { onSignOut, runConnect: run }
}

const button = (name: string) => screen.getByRole('button', { name })

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(allrWorkSignIn).mockResolvedValue({ busy: false, workspace: WORKSPACE })
  vi.mocked(connect).mockReset()
  vi.mocked(connect).mockResolvedValue(undefined)
})

afterEach(() => {
  $connection.set(null)
  $connectionPhase.set('idle')
  $allrWorkError.set(null)
  $allrWorkRestoreIssue.set(null)
  $allrWorkSignInFlight.set(false)
})

describe('AllrWorkPanel — idle', () => {
  it('offers the one sign-in and connects through the host’s soft switch', async () => {
    const { runConnect } = renderPanel()

    expect(screen.getByText('Sign in once. Allr finds your workspace and connects this device to it.')).toBeVisible()
    fireEvent.click(button('Sign in to Allr Work'))

    await waitFor(() => expect(connect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' }))
    expect(runConnect).toHaveBeenCalledOnce()
    expect(allrWorkSignIn).toHaveBeenCalledExactlyOnceWith({ switchAccount: false })
  })
})

describe('AllrWorkPanel — signing in', () => {
  it('shows progress and the desktop hint, and hides the buttons', () => {
    $allrWorkSignInFlight.set(true)
    renderPanel()

    expect(screen.getByText('Signing in to Allr Work…')).toBeVisible()
    expect(screen.getByText('Finish in the window that opened. Close it to cancel.')).toBeVisible()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('disables every button while its own dial runs, and ignores a second press', async () => {
    let finish: () => void = () => {}
    $allrWorkRestoreIssue.set('unreachable')

    const { runConnect } = renderPanel({
      runConnect: () => new Promise<void>(resolve => (finish = resolve))
    })

    fireEvent.click(button('Try again'))

    await waitFor(() => expect(button('Try again')).toBeDisabled())
    expect(button('Sign in again')).toBeDisabled()
    fireEvent.click(button('Sign in again'))
    expect(runConnect).toHaveBeenCalledOnce()

    await act(async () => finish())
    await waitFor(() => expect(button('Sign in again')).toBeEnabled())
  })

  it('hides the buttons when a sign-in starts elsewhere in this window', () => {
    $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    $connectionPhase.set('ready')
    renderPanel()

    expect(screen.getAllByRole('button')).toHaveLength(2)
    act(() => $allrWorkSignInFlight.set(true))

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('Signing in to Allr Work…')).toBeVisible()
  })
})

describe('AllrWorkPanel — signed in', () => {
  beforeEach(() => {
    $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    $connectionPhase.set('ready')
  })

  it('shows the workspace host with Switch account and Sign out', () => {
    const { onSignOut } = renderPanel()

    expect(screen.getByText('Connected to your workspace at xm.allr.work')).toBeVisible()
    expect(screen.getByText('Signed in')).toBeVisible()
    fireEvent.click(button('Sign out'))
    expect(onSignOut).toHaveBeenCalledOnce()
    expect(button('Switch account')).toBeEnabled()
  })

  it('switch account runs logout → clear → sign-in in order', async () => {
    const order: string[] = []

    vi.mocked(oauthLogout).mockImplementationOnce(async () => void order.push('logout'))
    vi.mocked(allrWorkClearSession).mockImplementationOnce(async () => {
      order.push('clear')

      return { cleared: 1, supported: true }
    })
    vi.mocked(allrWorkSignIn).mockImplementationOnce(async () => {
      order.push('sign-in')

      return { busy: false, workspace: 'https://other.allr.work' }
    })
    vi.mocked(connect).mockImplementationOnce(async () => void order.push('connect'))

    const { runConnect } = renderPanel()

    fireEvent.click(button('Switch account'))

    await waitFor(() => expect(order).toEqual(['logout', 'clear', 'sign-in', 'connect']))
    expect(oauthLogout).toHaveBeenCalledWith(WORKSPACE)
    expect(allrWorkClearSession).toHaveBeenCalledWith({ workspace: WORKSPACE, switchAccount: true })
    expect(allrWorkSignIn).toHaveBeenCalledWith({ switchAccount: true })
    expect(connect).toHaveBeenCalledWith({ url: 'https://other.allr.work', mode: 'allr' })
    expect(runConnect).toHaveBeenCalledOnce()
  })

  // The supervisor is bringing the socket back: still this workspace, not a signed-out card.
  it('says it is reconnecting to the workspace while the live socket comes back', () => {
    $connectionPhase.set('connecting')
    renderPanel()

    expect(screen.getByText('Reconnecting to your Allr Work workspace at xm.allr.work…')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Sign in to Allr Work' })).not.toBeInTheDocument()
    expect(button('Switch account')).toBeVisible()
    expect(button('Sign out')).toBeVisible()
  })

  it('is not signed in to a different mode’s connection', () => {
    $connection.set({ baseUrl: 'https://gw.example.com', mode: 'remote', authMode: 'oauth' })
    renderPanel()

    expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
    expect(button('Sign in to Allr Work')).toBeVisible()
  })
})

// Independent of the component's table on purpose: a kind wired to the wrong key has to fail.
const COPY: Record<Exclude<AllrWorkErrorKind, 'cancelled'>, string> = {
  'invalid-portal-config': 'The Allr Work address configured for this app is not valid.',
  'timed-out': 'Sign-in took too long. Try again.',
  'navigation-refused': 'The sign-in page could not be opened on this device.',
  'already-on-sign-in-page': 'A sign-in page is already open. Finish it or go back first.',
  'portal-refused': 'Allr Work could not confirm who you are. Try again.',
  'no-workspace':
    'This account doesn’t have an Allr Work workspace. Switch to the account your workspace was set up with.',
  'portal-outdated': 'Allr Work sign-in isn’t available yet for this service. Try again later.',
  'state-mismatch': 'The sign-in response didn’t match this request. Try again.',
  'invalid-workspace': 'Allr Work returned an address this app won’t connect to.',
  'workspace-unsupported': 'Your workspace doesn’t support app sign-in yet.',
  unreachable: 'Couldn’t reach Allr Work. Check your connection and try again.',
  'sign-in-failed': 'Your workspace refused the sign-in. Try again.',
  'credential-not-saved': 'Signed in, but this device couldn’t store the credential securely.',
  'cookie-store-failed': 'Signed out, but the sign-in page may still remember your account.'
}

describe('AllrWorkPanel — error kinds map to copy', () => {
  it('covers every kind the IPC layer knows, except cancelled', () => {
    expect([...ALLR_WORK_ERROR_KINDS].sort()).toEqual([...Object.keys(COPY), 'cancelled'].sort())
  })

  it.each(Object.entries(COPY) as [Exclude<AllrWorkErrorKind, 'cancelled'>, string][])(
    '%s renders its sentence as an alert, with Try again',
    (kind, sentence) => {
      $allrWorkError.set({ kind, message: 'raw Rust text' })
      renderPanel()

      expect(screen.getByRole('alert')).toHaveTextContent(sentence)
      expect(screen.queryByText('raw Rust text')).not.toBeInTheDocument()

      // Retrying cannot fix a broken portal address, nor a sign-out that only left cookies.
      if (kind === 'invalid-portal-config' || kind === 'cookie-store-failed') {
        expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
      } else {
        expect(button('Try again')).toBeVisible()
      }

      if (kind === 'no-workspace') {
        expect(button('Switch account')).toBeVisible()
      } else {
        expect(screen.queryByRole('button', { name: 'Switch account' })).not.toBeInTheDocument()
      }
    }
  )

  it('offers nothing for a broken portal address', () => {
    $allrWorkError.set({ kind: 'invalid-portal-config', message: 'Bad.' })
    renderPanel()

    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('offers a fresh sign-in, not a retry, after a cookie failure', () => {
    $allrWorkError.set({ kind: 'cookie-store-failed', message: 'Cookies.' })
    renderPanel()

    expect(button('Sign in to Allr Work')).toBeVisible()
  })

  // Announced once: the alert speaks, and the status line does not change under it.
  it('empties the status live region while the alert speaks', () => {
    renderPanel()
    expect(screen.getByRole('status')).toHaveTextContent('Sign in once.')

    act(() => $allrWorkError.set({ kind: 'timed-out', message: 'Slow.' }))

    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('alert')).toHaveTextContent(COPY['timed-out'])
    // Still on screen, just not re-announced.
    expect(screen.getByText('Sign in once. Allr finds your workspace and connects this device to it.')).toBeVisible()
  })

  // The store never keeps one, but the card must not trust that.
  it('cancelled renders nothing — the card stays idle', () => {
    $allrWorkError.set({ kind: 'cancelled', message: 'Closed.' })
    renderPanel()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(button('Sign in to Allr Work')).toBeVisible()
  })

  it('a cancelled sign-in stays silent end to end', async () => {
    vi.mocked(allrWorkSignIn).mockRejectedValueOnce(new AllrWorkInvokeError('cancelled', 'Closed.'))
    const { runConnect } = renderPanel()

    fireEvent.click(button('Sign in to Allr Work'))

    await waitFor(() => expect(runConnect).toHaveBeenCalledOnce())
    await waitFor(() => expect(button('Sign in to Allr Work')).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(notifyError).not.toHaveBeenCalled()
  })

  // The rollback re-dialled a previous Allr Work workspace, and that connect cleared the card.
  it('puts a failure back on the card after a rollback cleared it', async () => {
    let rolledBack = false

    vi.mocked(allrWorkSignIn).mockRejectedValueOnce(new AllrWorkInvokeError('no-workspace', 'No workspace.'))
    renderPanel({
      runConnect: async dial => {
        try {
          await dial()
        } catch (err) {
          $allrWorkError.set(null)
          rolledBack = true

          throw err
        }
      }
    })

    fireEvent.click(button('Sign in to Allr Work'))

    // Past the rollback AND the panel's own handling — not the moment in between, when the
    // store's copy of the failure was briefly on screen.
    await waitFor(() => expect(rolledBack).toBe(true))
    await act(async () => {})

    expect($allrWorkError.get()).toMatchObject({ kind: 'no-workspace' })
    expect(screen.getByRole('alert')).toHaveTextContent(COPY['no-workspace'])
  })

  it('toasts a failure that is not the card’s', async () => {
    const refused = new Error('connection refused')
    vi.mocked(connect).mockRejectedValueOnce(refused)
    renderPanel()

    fireEvent.click(button('Sign in to Allr Work'))

    await waitFor(() => expect(notifyError).toHaveBeenCalledWith(refused, 'Could not apply gateway settings'))
  })
})

describe('AllrWorkPanel — busy', () => {
  async function pressIntoBusy() {
    vi.mocked(allrWorkSignIn).mockResolvedValueOnce({ busy: true, workspace: null })
    renderPanel()
    fireEvent.click(button('Sign in to Allr Work'))

    return screen.findByText('A sign-in is already in progress.')
  }

  it('is forgotten once a sign-in starts in this window, and stays gone after it ends', async () => {
    await pressIntoBusy()

    act(() => $allrWorkSignInFlight.set(true))
    expect(screen.queryByText('A sign-in is already in progress.')).not.toBeInTheDocument()

    act(() => $allrWorkSignInFlight.set(false))
    expect(screen.queryByText('A sign-in is already in progress.')).not.toBeInTheDocument()
  })

  it('answers a Switch account pressed while signed in', async () => {
    $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
    $connectionPhase.set('ready')
    vi.mocked(allrWorkSignIn).mockResolvedValueOnce({ busy: true, workspace: null })
    renderPanel()

    fireEvent.click(button('Switch account'))

    expect(await screen.findByText('A sign-in is already in progress.')).toBeVisible()
    expect(screen.getByText('Connected to your workspace at xm.allr.work')).toBeVisible()
  })

  it('is forgotten once the card connects, and stays gone after it drops', async () => {
    await pressIntoBusy()

    act(() => {
      $connection.set({ baseUrl: WORKSPACE, mode: 'allr', authMode: 'oauth' })
      $connectionPhase.set('ready')
    })
    expect(screen.queryByText('A sign-in is already in progress.')).not.toBeInTheDocument()

    act(() => {
      $connection.set(null)
      $connectionPhase.set('idle')
    })
    expect(screen.queryByText('A sign-in is already in progress.')).not.toBeInTheDocument()
  })

  it('is a neutral notice, not an error', async () => {
    vi.mocked(allrWorkSignIn).mockResolvedValueOnce({ busy: true, workspace: null })
    renderPanel()

    fireEvent.click(button('Sign in to Allr Work'))

    const notice = await screen.findByText('A sign-in is already in progress.')

    expect(notice.closest('[data-slot="allr-work-busy"]')).not.toBeNull()
    expect(notice.closest('[data-slot="allr-work-busy"]')?.className).not.toContain('text-destructive')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(notifyError).not.toHaveBeenCalled()
    expect($allrWorkError.get()).toBeNull()
  })
})

describe('AllrWorkPanel — restore issues', () => {
  it('session-ended offers a fresh sign-in only', async () => {
    $allrWorkRestoreIssue.set('session-ended')
    renderPanel()

    expect(screen.getByText('Your Allr Work session ended. Sign in again to reconnect.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()

    fireEvent.click(button('Sign in to Allr Work'))
    await waitFor(() => expect(allrWorkSignIn).toHaveBeenCalledOnce())
  })

  it('unreachable offers Try again (re-dial, no sign-in) and Sign in again', async () => {
    saveGatewayTarget({ mode: 'allr', url: WORKSPACE })
    $allrWorkRestoreIssue.set('unreachable')
    renderPanel()

    expect(
      screen.getByText('Couldn’t reach your Allr Work workspace. Try again, or sign in again if this keeps happening.')
    ).toBeVisible()

    fireEvent.click(button('Try again'))
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ url: WORKSPACE, mode: 'allr' }))
    expect(allrWorkSignIn).not.toHaveBeenCalled()

    await waitFor(() => expect(button('Sign in again')).toBeEnabled())
    fireEvent.click(button('Sign in again'))
    await waitFor(() => expect(allrWorkSignIn).toHaveBeenCalledOnce())
  })
})
