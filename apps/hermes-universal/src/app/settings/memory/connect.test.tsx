/**
 * The memory-provider OAuth connect affordance, and the one thing about it that
 * only a clock can prove: the poll GIVES UP.
 *
 * `MemoryConnect` claims a 120s budget for "waiting for browser consent", then
 * polls the gateway every 1.5s. The budget is the whole reason the spinner is
 * safe to show — without it a user who starts a connection against a gateway
 * that is down watches it spin for as long as the page stays open, and the app
 * keeps issuing a request every 1.5s behind it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getMemoryProviderOAuthStatus = vi.fn()
const startMemoryProviderOAuth = vi.fn()

vi.mock('@/hermes', () => ({
  getMemoryProviderOAuthStatus: (provider: string) => getMemoryProviderOAuthStatus(provider),
  startMemoryProviderOAuth: (provider: string) => startMemoryProviderOAuth(provider)
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

import { MemoryConnect } from './connect'

const POLL_MS = 1500
const POLL_TIMEOUT_MS = 120_000

/** Let every pending microtask (the awaited RPC) settle inside `act`. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Render, let the capability probe answer, and start a connection. */
async function startConnecting(): Promise<void> {
  render(<MemoryConnect provider="mem0" />)
  await settle()

  fireEvent.click(screen.getByRole('button', { name: /Connect/ }))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  getMemoryProviderOAuthStatus.mockReset()
  startMemoryProviderOAuth.mockReset()
  // The capability probe: a resolved status is what makes the affordance render
  // at all (a 404 means this provider has no OAuth flow and it renders nothing).
  getMemoryProviderOAuthStatus.mockResolvedValue({ auth: null, connected: false, detail: '', state: 'idle' })
  startMemoryProviderOAuth.mockResolvedValue({ auth: null, connected: false, detail: '', state: 'pending' })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MemoryConnect', () => {
  it('renders nothing for a provider whose status route 404s', async () => {
    getMemoryProviderOAuthStatus.mockRejectedValue(new Error('404 Not Found'))

    const { container } = render(<MemoryConnect provider="builtin" />)
    await settle()

    expect(container).toBeEmptyDOMElement()
  })

  it('gives up at the deadline when the gateway is unreachable, and stops polling', async () => {
    await startConnecting()

    expect(screen.getByText('Waiting for browser consent…')).toBeInTheDocument()

    // Down, not slow: every poll rejects. This is the path that used to `return`
    // out of the tick before the deadline was ever read.
    getMemoryProviderOAuthStatus.mockRejectedValue(new Error('gateway down'))

    await tick(POLL_TIMEOUT_MS + POLL_MS * 2)

    expect(screen.getByText('Timed out — try again.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for browser consent…')).not.toBeInTheDocument()

    // And the interval is really cleared — a message alone would still leave a
    // request going out every 1.5s forever behind it.
    const afterTimeout = getMemoryProviderOAuthStatus.mock.calls.length

    // Under the 6s error-clear timer, so the assertion above stays meaningful.
    await tick(POLL_MS * 3)

    expect(getMemoryProviderOAuthStatus.mock.calls.length).toBe(afterTimeout)
  })

  it('gives up at the deadline when the gateway answers pending forever', async () => {
    await startConnecting()

    getMemoryProviderOAuthStatus.mockResolvedValue({ auth: null, connected: false, detail: '', state: 'pending' })

    await tick(POLL_TIMEOUT_MS + POLL_MS * 2)

    expect(screen.getByText('Timed out — try again.')).toBeInTheDocument()
  })

  it('keeps polling through a transient failure and settles on the eventual success', async () => {
    await startConnecting()

    getMemoryProviderOAuthStatus.mockRejectedValueOnce(new Error('one bad response'))
    getMemoryProviderOAuthStatus.mockResolvedValue({
      auth: 'oauth',
      connected: true,
      detail: '',
      state: 'connected'
    })

    await tick(POLL_MS * 3)

    // A single failure must NOT abort the flow — the deadline is what ends it.
    expect(screen.getByText('oauth set')).toBeInTheDocument()
    expect(screen.queryByText('Timed out — try again.')).not.toBeInTheDocument()
  })

  it('stops polling when the user cancels', async () => {
    await startConnecting()

    getMemoryProviderOAuthStatus.mockResolvedValue({ auth: null, connected: false, detail: '', state: 'pending' })
    await tick(POLL_MS * 2)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()

    const afterCancel = getMemoryProviderOAuthStatus.mock.calls.length

    await tick(POLL_MS * 4)

    expect(getMemoryProviderOAuthStatus.mock.calls.length).toBe(afterCancel)
  })
})
