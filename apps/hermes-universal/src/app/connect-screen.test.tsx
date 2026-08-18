import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The first-run wizard: welcome → choose a gateway → configure that one.
//
// The welcome flag is mocked rather than exercised end-to-end; lib/app-flags has
// its own tests for the native/localStorage split. What matters here is the
// SEQUENCE, and one timing property that is easy to regress: the flag read is
// async, so a returning user must never see the welcome screen flash.
vi.mock('@/lib/app-flags', () => ({ getAppFlag: vi.fn(), setAppFlag: vi.fn() }))

import { I18nProvider } from '@/i18n'
import { getAppFlag, setAppFlag } from '@/lib/app-flags'
import { queryClient } from '@/lib/query-client'

import { ConnectScreen } from './connect-screen'

const mockGet = vi.mocked(getAppFlag)
const mockSet = vi.mocked(setAppFlag)

function renderScreen() {
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ConnectScreen />
      </QueryClientProvider>
    </I18nProvider>
  )
}

/** A gateway card, by its title. ModeCard is a <button> wrapping the title, so
 *  the click has to land on the button, not the inner <span>. */
function pickGateway(title: string): HTMLElement {
  const button = screen.getByText(title).closest('button')

  expect(button).not.toBeNull()

  return button as HTMLElement
}

/** Render with the welcome already dismissed and wait for the picker. */
async function renderAtPicker() {
  mockGet.mockResolvedValue(true)

  const view = renderScreen()

  await screen.findByText('Choose a gateway')

  return view
}

beforeEach(() => {
  mockGet.mockReset()
  mockSet.mockReset()
  mockSet.mockResolvedValue(undefined)
  localStorage.clear()
})

describe('the welcome step', () => {
  it('greets a first run, with no gateway cards yet', async () => {
    mockGet.mockResolvedValue(false)
    renderScreen()

    expect(await screen.findByText('Welcome to Allr')).toBeInTheDocument()
    expect(screen.queryByText('Choose a gateway')).not.toBeInTheDocument()
    expect(screen.queryByText('Allr Cloud')).not.toBeInTheDocument()
  })

  it('offers a language picker, so the choice comes before the prose', async () => {
    mockGet.mockResolvedValue(false)
    renderScreen()

    await screen.findByText('Welcome to Allr')
    expect(screen.getByRole('button', { name: 'Switch language' })).toBeInTheDocument()
  })

  it('advances to the gateway picker and records that it was shown', async () => {
    mockGet.mockResolvedValue(false)
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: "Let's get started" }))

    expect(await screen.findByText('Choose a gateway')).toBeInTheDocument()
    expect(mockSet).toHaveBeenCalledWith('connectWelcomed', true)
  })

  it('advances even when the flag cannot be persisted', async () => {
    mockGet.mockResolvedValue(false)
    mockSet.mockRejectedValue(new Error('disk full'))
    renderScreen()

    fireEvent.click(await screen.findByRole('button', { name: "Let's get started" }))

    // Showing the welcome twice is a cheaper failure than a dead button.
    expect(await screen.findByText('Choose a gateway')).toBeInTheDocument()
  })

  it('is skipped for a returning user — with no flash while the flag resolves', async () => {
    let resolveFlag: (seen: boolean) => void = () => {}

    mockGet.mockReturnValue(
      new Promise<boolean>(resolve => {
        resolveFlag = resolve
      })
    )

    renderScreen()

    // The pre-resolution frame: neither step, rather than a welcome that will be
    // yanked away. Defaulting the state to 'welcome' would pass every other test
    // in this file and still flash the screen at every returning user.
    expect(screen.queryByText('Welcome to Allr')).not.toBeInTheDocument()
    expect(screen.queryByText('Choose a gateway')).not.toBeInTheDocument()

    resolveFlag(true)

    expect(await screen.findByText('Choose a gateway')).toBeInTheDocument()
    expect(screen.queryByText('Welcome to Allr')).not.toBeInTheDocument()
  })
})

describe('the gateway picker step', () => {
  it('lists the gateways without any one gateway’s fields', async () => {
    await renderAtPicker()

    expect(screen.getByText('Allr Cloud')).toBeInTheDocument()
    expect(screen.getByText('Remote gateway')).toBeInTheDocument()
    expect(screen.getByText('SSH')).toBeInTheDocument()
    // Nothing is configured until a gateway is picked.
    expect(screen.queryByRole('button', { name: 'Save and reconnect' })).not.toBeInTheDocument()
  })

  it('offers the local gateway on desktop', async () => {
    // LOCAL_MODE_SUPPORTED is !IS_MOBILE, and platform() throws without a Tauri
    // runtime, so vitest resolves to desktop-like defaults.
    await renderAtPicker()

    expect(screen.getByText('Local gateway')).toBeInTheDocument()
  })

  it('keeps the cards single-column — it renders inside a 420px card', async () => {
    const { container } = await renderAtPicker()
    const grid = container.querySelector('.auto-rows-fr')

    // The breakpoint is a VIEWPORT media query, so on a wide window either of
    // these would crush four cards into the connect card's width.
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-3')
    expect(grid?.className).not.toContain('min-[42rem]:grid-cols-4')
  })
})

describe('the configure step', () => {
  it('shows only the picked gateway, reached in one tap', async () => {
    await renderAtPicker()

    fireEvent.click(pickGateway('Remote gateway'))

    // The picker is gone and the remote surface is up.
    expect(screen.queryByText('Choose a gateway')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save and reconnect' })).toBeInTheDocument()
    // SSH's fields belong to a gateway that was not picked.
    expect(screen.queryByText('Private key file')).not.toBeInTheDocument()
  })

  it('goes back to the picker with the selection intact', async () => {
    await renderAtPicker()

    fireEvent.click(pickGateway('SSH'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(await screen.findByText('Choose a gateway')).toBeInTheDocument()

    // Back rewinds the wizard only — the pending selection survives, so
    // returning lands on SSH rather than resetting to the persisted default.
    fireEvent.click(pickGateway('SSH'))
    expect(screen.getByText('Host')).toBeInTheDocument()
  })
})

describe('the local gateway sub-flow', () => {
  // The wizard has exactly ONE Back. Picking a repo used to add a second one
  // underneath it; now the header's Back steps through the sub-flow instead.
  it('keeps a single Back that unwinds one level at a time', async () => {
    await renderAtPicker()

    fireEvent.click(pickGateway('Local gateway'))

    // No Tauri runtime here, so detection rejects and resolves to "missing" —
    // the same screen a machine without Allr shows.
    expect(await screen.findByText('No local installation found')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1)

    fireEvent.click(screen.getByText('MJX Fork of Hermes Agent')) // rebrand:keep — names the upstream project, not ours
    await screen.findByRole('button', { name: 'Install' })

    // Still one — this is the regression.
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('No local installation found')).toBeInTheDocument()

    // And once the sub-flow is exhausted it rewinds the wizard itself.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Choose a gateway')).toBeInTheDocument()
  })
})

describe('connection errors', () => {
  it('are shown on the connect steps, not over the welcome', async () => {
    const { $connectionError } = await import('@/store/connection')

    $connectionError.set('gateway unreachable')
    mockGet.mockResolvedValue(false)

    renderScreen()
    await screen.findByText('Welcome to Allr')
    expect(screen.queryByText('gateway unreachable')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: "Let's get started" }))
    await waitFor(() => expect(screen.getByText('gateway unreachable')).toBeInTheDocument())

    $connectionError.set(null)
  })
})
