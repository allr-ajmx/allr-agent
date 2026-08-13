import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setReactionsEnabled } from '@/store/reactions-enabled'

import { useComposerTrigger } from './hooks/use-composer-trigger'
import { composerPlainText, renderComposerContents, RICH_INPUT_SLOT } from './rich-editor'

/**
 * The `:shortcode:` trigger, driven through the REAL engine the docked composer
 * runs on, against a real contentEditable.
 *
 * MJXHRM-224 shipped `kind: ':'`, `EMOJI_TRIGGER_RE` and an emoji completion
 * source, and every test it added was a store-level one — so nothing covered the
 * path from a keystroke to an open menu. It did not work: `refreshTrigger` kept
 * its own list of characters that can start a trigger (`@` and `/`), and screened
 * the draft against it before `detectTrigger` ever ran. A `:` in prose carrying
 * neither of those was discarded, which is nearly every message. The first test
 * below is that bug.
 */
function emojiItem(emoji: string, code: string): Unstable_TriggerItem {
  return {
    id: `${emoji}|0`,
    type: 'emoji',
    label: `${emoji}  :${code}:`,
    metadata: { display: `${emoji}  :${code}:`, rawText: emoji, meta: '', group: '', action: '' }
  }
}

/** Caret at the end, which is where a typed trigger always leaves it. Re-placed
 *  after every rewrite: replacing an element's children collapses any range
 *  anchored in them to offset 0, and a caret at 0 sees no text before it. */
function placeCaretAtEnd(editor: HTMLDivElement) {
  const range = document.createRange()

  range.selectNodeContents(editor)
  range.collapse(false)

  const sel = window.getSelection()

  sel?.removeAllRanges()
  sel?.addRange(range)
}

function setup(initialText: string) {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  // The real composer marks its editor with this slot; `composerPlainText` keys
  // off it to decide whether a DIV contributes a trailing newline.
  editor.dataset.slot = RICH_INPUT_SLOT
  document.body.append(editor)
  renderComposerContents(editor, initialText)
  placeCaretAtEnd(editor)

  const editorRef = { current: editor as HTMLDivElement | null }
  const draftRef = { current: initialText }
  const setComposerText = vi.fn()
  const composingRef = { current: false }

  const { result } = renderHook(() =>
    useComposerTrigger({
      at: { adapter: null, loading: false },
      composingRef,
      draftRef,
      editorRef,
      emoji: { adapter: null, loading: false },
      requestMainFocus: vi.fn(),
      setComposerText,
      slash: { adapter: null, loading: false }
    })
  )

  const refresh = () =>
    act(() => {
      result.current.refreshTrigger()
    })

  /** What a keystroke leaves behind: new text, caret at the end, then the
   *  refresh keyup schedules. */
  const type = (nextText: string) => {
    renderComposerContents(editor, nextText)
    placeCaretAtEnd(editor)
    refresh()
  }

  refresh()

  return { composingRef, editor, refresh, result, setComposerText, type }
}

afterEach(() => {
  setReactionsEnabled(false)
  document.body.replaceChildren()
})

describe('the `:` trigger reaches the engine', () => {
  it('opens on `:jo` in prose that carries no @ or /', () => {
    setReactionsEnabled(true)

    const { result } = setup('hello :jo')

    expect(result.current.trigger).toMatchObject({ kind: ':', query: 'jo' })
  })

  it('still opens when an @ or / is also present, which is how it ever appeared to work', () => {
    setReactionsEnabled(true)

    expect(setup('@file:x.ts and :jo').result.current.trigger).toMatchObject({ kind: ':', query: 'jo' })
  })

  it('leaves a directive starter alone — `@file:` is an @ query, not an emoji one', () => {
    setReactionsEnabled(true)

    expect(setup('@file:').result.current.trigger).toMatchObject({ kind: '@', query: 'file:' })
  })

  it('ignores a colon that is not a shortcode', () => {
    setReactionsEnabled(true)

    expect(setup('meet at 12:30').result.current.trigger).toBeNull()
    expect(setup('ratio 3:1').result.current.trigger).toBeNull()
    expect(setup('so:').result.current.trigger).toBeNull()
  })

  it('closes again when the shortcode is deleted', () => {
    setReactionsEnabled(true)

    const { result, type } = setup('hello :jo')

    expect(result.current.trigger).not.toBeNull()

    type('hello ')

    expect(result.current.trigger).toBeNull()
  })
})

describe('picking an emoji', () => {
  it('inserts the character as plain text, never a chip', () => {
    setReactionsEnabled(true)

    const { editor, result, setComposerText } = setup('hello :jo')

    act(() => {
      result.current.replaceTriggerWithChip(emojiItem('\u{1F602}', 'joy'))
    })

    expect(composerPlainText(editor)).toBe('hello \u{1F602} ')
    expect(editor.querySelector('[data-ref-text]')).toBeNull()
    expect(setComposerText).toHaveBeenCalledWith('hello \u{1F602} ')
  })

  it('closes the menu on the pick', () => {
    setReactionsEnabled(true)

    const { result } = setup('hello :jo')

    act(() => {
      result.current.replaceTriggerWithChip(emojiItem('\u{1F602}', 'joy'))
    })

    expect(result.current.trigger).toBeNull()
  })
})

describe('the feature flag', () => {
  it('keeps the menu shut while reactions are off', () => {
    expect(setup('hello :jo').result.current.trigger).toBeNull()
  })

  it('does not disturb @ or / while it is off', () => {
    expect(setup('@fi').result.current.trigger).toMatchObject({ kind: '@' })
    expect(setup('/hel').result.current.trigger).toMatchObject({ kind: '/' })
  })
})

describe('an IME composition', () => {
  // A `:` is a live character in CJK and European input methods, and keyup fires
  // for every physical key of a preedit. Detecting against the editor mid-
  // composition opens a menu over the input method's own candidate window, on
  // characters the user has not committed and may yet discard.
  it('does not open the menu while a preedit is open', () => {
    setReactionsEnabled(true)

    const { composingRef, result, type } = setup('hello ')

    composingRef.current = true
    type('hello :jo')

    expect(result.current.trigger).toBeNull()
  })

  it('opens on what the input method actually committed', () => {
    setReactionsEnabled(true)

    const { composingRef, refresh, result, type } = setup('hello ')

    composingRef.current = true
    type('hello :jo')

    // compositionend: the latch drops, and the refresh that follows it sees
    // committed text.
    composingRef.current = false
    refresh()

    expect(result.current.trigger).toMatchObject({ kind: ':', query: 'jo' })
  })

  it('guards @ and / the same way — the preedit is not a trigger for any kind', () => {
    const { composingRef, result, type } = setup('hello ')

    composingRef.current = true
    type('hello @fi')

    expect(result.current.trigger).toBeNull()
  })
})
