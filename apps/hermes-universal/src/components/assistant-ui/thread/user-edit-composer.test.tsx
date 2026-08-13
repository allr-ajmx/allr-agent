/**
 * Editing a sent message: the IME guard, and the `:shortcode:` emoji menu.
 *
 * This composer's Enter is destructive — it rewinds the conversation to that
 * message and re-runs it — and it had no composition guard, so the Enter a
 * Japanese/Korean/Chinese typist presses to CONFIRM a preedit sent the edit
 * instead, with half-composed text in it. The docked composer has carried that
 * guard since the port (`app/chat/composer/index.tsx`); the edit composer was
 * ported without it, and there is no undo for the send it made.
 *
 * The emoji menu lands on the same destructive Enter, which is why the two live
 * in one file: with the menu up, Enter must pick a completion and MUST NOT send.
 *
 * The runtime is stubbed down to the three verbs this component calls, so the
 * test is about the keyboard and nothing else. The emoji source is stubbed too —
 * the real one fetches emojibase JSON off the app's own origin, which is not
 * what any of this is about.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setReactionsEnabled } from '@/store/reactions-enabled'

const composerApi = vi.hoisted(() => ({
  cancel: vi.fn(),
  send: vi.fn(),
  setText: vi.fn()
}))

const emojiItems = vi.hoisted(() => [
  {
    id: '\u{1F602}|0',
    type: 'emoji',
    label: '\u{1F602}  :joy:',
    metadata: { display: '\u{1F602}  :joy:', rawText: '\u{1F602}', meta: '', group: '', action: '' }
  },
  {
    id: '\u{1F0CF}|1',
    type: 'emoji',
    label: '\u{1F0CF}  :joker:',
    metadata: { display: '\u{1F0CF}  :joker:', rawText: '\u{1F0CF}', meta: '', group: '', action: '' }
  }
])

vi.mock('@assistant-ui/react', () => ({
  ComposerPrimitive: {
    Input: () => null,
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  },
  useAui: () => ({ composer: () => composerApi }),
  useAuiState: () => 'the original prompt'
}))

// One stable source object, as the real hook returns (its adapter is memoized).
// A fresh one per render would change the trigger engine's effect deps on every
// render, which is a loop rather than a test.
const emojiSource = vi.hoisted(() => ({
  adapter: { categories: () => [], categoryItems: () => [], search: () => emojiItems },
  loading: false
}))

vi.mock('@/app/chat/composer/hooks/use-emoji-completions', () => ({
  useEmojiCompletions: () => emojiSource
}))

const { UserEditComposer } = await import('./user-edit-composer')

const editor = () => screen.getByRole('textbox')

/** Replacing an element's children collapses any range anchored in them to
 *  offset 0, so the caret has to be re-placed after every rewrite — a caret at 0
 *  sees no text before it and no trigger can be detected. */
function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange()

  range.selectNodeContents(el)
  range.collapse(false)

  const sel = window.getSelection()

  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** One keystroke's worth of effect: text, caret, input, keyup — then let the
 *  refresh keyup schedules actually run. */
function type(text: string) {
  const el = editor()

  el.textContent = text
  placeCaretAtEnd(el)
  fireEvent.input(el)
  fireEvent.keyUp(el, { key: text.slice(-1) })

  act(() => {
    vi.advanceTimersByTime(1)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  composerApi.cancel.mockClear()
  composerApi.send.mockClear()
  composerApi.setText.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  setReactionsEnabled(false)
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

describe('the edit composer and `:shortcode:` completions', () => {
  it('opens the emoji menu on a shortcode typed into a sent message', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')

    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getByRole('option', { name: /:joy:/ })).toBeTruthy()
  })

  it('picks on Enter and does NOT re-run the turn', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')
    fireEvent.keyDown(editor(), { key: 'Enter' })

    // The whole point: Enter here normally rewinds the conversation to this
    // message and re-runs it, and there is no undo for that.
    expect(composerApi.send).not.toHaveBeenCalled()
    expect(editor().textContent).toBe('nice work \u{1F602} ')
    expect(composerApi.setText).toHaveBeenCalledWith('nice work \u{1F602} ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('inserts the emoji as text, not a chip', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')
    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(editor().querySelector('[data-ref-text]')).toBeNull()
  })

  it('accepts on Tab as well', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')
    fireEvent.keyDown(editor(), { key: 'Tab' })

    expect(editor().textContent).toBe('nice work \u{1F602} ')
  })

  it('walks the list with the arrow keys', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')
    fireEvent.keyDown(editor(), { key: 'ArrowDown' })

    expect(screen.getByRole('option', { name: /:joker:/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(editor().textContent).toBe('nice work \u{1F0CF} ')
  })

  it('dismisses on Escape without cancelling the edit', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')
    fireEvent.keyDown(editor(), { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    // Escape here discards the whole edit — losing a message to the key that
    // dismisses a menu is not a trade worth making.
    expect(composerApi.cancel).not.toHaveBeenCalled()

    fireEvent.keyDown(editor(), { key: 'Escape' })

    expect(composerApi.cancel).toHaveBeenCalledTimes(1)
  })

  it('does not reopen on the keyup of the Escape that closed it', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('nice work :jo')
    fireEvent.keyDown(editor(), { key: 'Escape' })
    fireEvent.keyUp(editor(), { key: 'Escape' })

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('stays shut while the emoji surface is off — Enter still sends', () => {
    render(<UserEditComposer />)

    type('nice work :jo')

    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(composerApi.send).toHaveBeenCalledTimes(1)
  })

  it('leaves a bare colon and a clock time alone', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    type('meet at 12:30')

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  // `:` is a live character in CJK and European input methods, and keyup fires
  // for every physical key of a preedit. A menu opened on composition keys sits
  // over the input method's own candidate window — and this is the composer
  // whose Enter cannot be undone.
  it('does not open on the keys of an IME preedit', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    const el = editor()

    fireEvent.compositionStart(el)
    el.textContent = 'nice work :jo'
    placeCaretAtEnd(el)
    fireEvent.input(el)
    fireEvent.keyUp(el, { key: 'o' })

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens on what the IME committed, once it has committed it', () => {
    setReactionsEnabled(true)
    render(<UserEditComposer />)

    const el = editor()

    fireEvent.compositionStart(el)
    el.textContent = 'nice work :jo'
    placeCaretAtEnd(el)
    fireEvent.input(el)
    fireEvent.keyUp(el, { key: 'o' })

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.compositionEnd(el)

    act(() => {
      vi.advanceTimersByTime(1)
    })

    expect(screen.getByRole('listbox')).toBeTruthy()
  })
})
