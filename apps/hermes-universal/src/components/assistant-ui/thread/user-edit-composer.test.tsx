/**
 * Editing a sent message with an IME.
 *
 * This composer's Enter is destructive — it rewinds the conversation to that
 * message and re-runs it — and it had no composition guard, so the Enter a
 * Japanese/Korean/Chinese typist presses to CONFIRM a preedit sent the edit
 * instead, with half-composed text in it. The docked composer has carried that
 * guard since the port (`app/chat/composer/index.tsx`); the edit composer was
 * ported without it, and there is no undo for the send it made.
 *
 * The runtime is stubbed down to the three verbs this component calls, so the
 * test is about the keyboard and nothing else.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const composerApi = vi.hoisted(() => ({
  cancel: vi.fn(),
  send: vi.fn(),
  setText: vi.fn()
}))

vi.mock('@assistant-ui/react', () => ({
  ComposerPrimitive: {
    Input: () => null,
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  },
  useAui: () => ({ composer: () => composerApi }),
  useAuiState: () => 'the original prompt'
}))

const { UserEditComposer } = await import('./user-edit-composer')

const editor = () => screen.getByRole('textbox')

beforeEach(() => {
  composerApi.cancel.mockClear()
  composerApi.send.mockClear()
  composerApi.setText.mockClear()
})

describe('the edit composer and an IME', () => {
  it('sends on a plain Enter', () => {
    render(<UserEditComposer />)
    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(composerApi.send).toHaveBeenCalledTimes(1)
  })

  it('does not send on the Enter that confirms a preedit', () => {
    render(<UserEditComposer />)

    fireEvent.compositionStart(editor())
    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(composerApi.send).not.toHaveBeenCalled()
  })

  it('sends on the Enter after the composition is committed', () => {
    render(<UserEditComposer />)

    fireEvent.compositionStart(editor())
    fireEvent.keyDown(editor(), { key: 'Enter' })
    fireEvent.compositionEnd(editor())
    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(composerApi.send).toHaveBeenCalledTimes(1)
  })

  // Escape ends an IME preedit too; cancelling the whole edit on it would throw
  // the user's typing away for a key they pressed at the input method.
  it('does not cancel the edit on the Escape that ends a preedit', () => {
    render(<UserEditComposer />)

    fireEvent.compositionStart(editor())
    fireEvent.keyDown(editor(), { key: 'Escape' })

    expect(composerApi.cancel).not.toHaveBeenCalled()
  })

  it('flushes what the IME committed, not the preedit it typed on the way', () => {
    render(<UserEditComposer />)

    const el = editor()

    // Preedit lands in the DOM (the engine writes it there), and the input
    // events that carry it must not reach the draft.
    el.textContent = 'にほn'
    fireEvent.compositionStart(el)
    fireEvent.input(el)

    expect(composerApi.setText).not.toHaveBeenCalled()

    el.textContent = '日本語'
    fireEvent.compositionEnd(el)

    expect(composerApi.setText).toHaveBeenCalledWith('日本語')
  })
})
