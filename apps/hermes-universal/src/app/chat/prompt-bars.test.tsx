import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/chat', () => ({
  respondApproval: vi.fn(),
  respondSecret: vi.fn(),
  respondSudo: vi.fn()
}))
vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

import { respondApproval, respondSecret, respondSudo } from '@/store/chat'
import { notify, notifyError } from '@/store/notifications'

import { ApprovalBar } from './approval-bar'
import { SecretBar } from './secret-bar'
import { SudoBar } from './sudo-bar'

// MJXHRM-418. These three bars are the only surface that can tell the user their
// answer did not land. Each responder has TWO failure shapes and the bar has to
// speak for both:
//
//  - a REJECTION (gateway down, dead runtime) — the request stays, the bar stays
//    answerable, and an error toast says why;
//  - an `expired` OUTCOME — an RPC that succeeded and delivered nothing, because
//    the tool it was blocking had already given up. The bar goes (nothing will
//    ever consume the answer) but a warning says the command did not run.
//
// A bar that silently disappears on either is the bug: it reads as "accepted".

const KEY = 'sess-1'

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } })

beforeEach(() => {
  vi.mocked(respondApproval).mockReset().mockResolvedValue('delivered')
  vi.mocked(respondSudo).mockReset().mockResolvedValue('delivered')
  vi.mocked(respondSecret).mockReset().mockResolvedValue('delivered')
  vi.mocked(notify).mockReset()
  vi.mocked(notifyError).mockReset()
})

afterEach(cleanup)

describe('ApprovalBar', () => {
  const request = { allowPermanent: true, command: 'rm -rf /tmp/x', description: 'dangerous command' }

  it('answers for the session it was handed, not the active one', async () => {
    render(<ApprovalBar request={request} sessionKey={KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => expect(respondApproval).toHaveBeenCalledWith('once', KEY))
    expect(notify).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  // `approval.respond` answers `{"resolved": 0}` once the five-minute approval
  // timeout has taken the request off the queue — the command was BLOCKED.
  it('warns when the approval had already timed out', async () => {
    vi.mocked(respondApproval).mockResolvedValue('expired')
    render(<ApprovalBar request={request} sessionKey={KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(vi.mocked(notify).mock.calls[0]?.[0].kind).toBe('warning'))
    expect(vi.mocked(notify).mock.calls[0][0].message).toContain('timed out')
  })

  it('surfaces a rejected send and re-enables the buttons so it can be retried', async () => {
    vi.mocked(respondApproval).mockRejectedValue(new Error('offline'))
    render(<ApprovalBar request={request} sessionKey={KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    await waitFor(() => expect(notifyError).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('SudoBar', () => {
  const request = { prompt: 'Password for hermes:', requestId: 's1' }

  it('sends the typed password for its own session', async () => {
    render(<SudoBar request={request} sessionKey={KEY} />)
    type(screen.getByPlaceholderText('Password'), 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(respondSudo).toHaveBeenCalledWith('hunter2', KEY))
    expect(notify).not.toHaveBeenCalled()
  })

  // `sudo.respond` is `allow_expired`: the gateway takes a late password and
  // drops it on the floor, so the command it was for stays cancelled.
  it('warns when the sudo prompt had already timed out', async () => {
    vi.mocked(respondSudo).mockResolvedValue('expired')
    render(<SudoBar request={request} sessionKey={KEY} />)
    type(screen.getByPlaceholderText('Password'), 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(vi.mocked(notify).mock.calls[0]?.[0].kind).toBe('warning'))
    expect(vi.mocked(notify).mock.calls[0][0].message).toContain('timed out')
  })

  // Cancel is an answer too (an empty password), and it can expire exactly the
  // same way — it must not look like it cancelled cleanly when it did nothing.
  it('warns when a cancel lands on an expired prompt', async () => {
    vi.mocked(respondSudo).mockResolvedValue('expired')
    render(<SudoBar request={request} sessionKey={KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(respondSudo).toHaveBeenCalledWith('', KEY))
    expect(vi.mocked(notify).mock.calls[0][0].kind).toBe('warning')
  })

  it('surfaces a rejected send and keeps the bar answerable', async () => {
    vi.mocked(respondSudo).mockRejectedValue(new Error('offline'))
    render(<SudoBar request={request} sessionKey={KEY} />)
    type(screen.getByPlaceholderText('Password'), 'hunter2')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(notifyError).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('SecretBar', () => {
  const request = { envVar: 'API_KEY', prompt: 'Value for API_KEY', requestId: 'x1' }

  it('sends the typed value for its own session', async () => {
    render(<SecretBar request={request} sessionKey={KEY} />)
    type(screen.getByPlaceholderText('API_KEY'), 'sk-1')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(respondSecret).toHaveBeenCalledWith('sk-1', KEY))
    expect(notify).not.toHaveBeenCalled()
  })

  it('warns when the secret prompt had already timed out', async () => {
    vi.mocked(respondSecret).mockResolvedValue('expired')
    render(<SecretBar request={request} sessionKey={KEY} />)
    type(screen.getByPlaceholderText('API_KEY'), 'sk-1')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(vi.mocked(notify).mock.calls[0]?.[0].kind).toBe('warning'))
    expect(vi.mocked(notify).mock.calls[0][0].message).toContain('timed out')
  })

  it('surfaces a rejected send and keeps the bar answerable', async () => {
    vi.mocked(respondSecret).mockRejectedValue(new Error('offline'))
    render(<SecretBar request={request} sessionKey={KEY} />)
    type(screen.getByPlaceholderText('API_KEY'), 'sk-1')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(notifyError).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false)
  })
})
