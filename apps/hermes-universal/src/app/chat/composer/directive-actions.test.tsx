/**
 * The composer's hover action pill, driven through real pointer events against a
 * real contentEditable — the surface has no other coverage, and every one of its
 * decisions (which chip is actionable, when the pill hides, what a press runs)
 * lives in DOM handlers rather than in a pure function.
 *
 * The regression the middle cases pin: the document-level `pointerout` listener
 * fired for moves INSIDE the pill (its wrapper → its button, its icon → its
 * label), and each one scheduled the hide. Nothing re-cancelled it, because the
 * wrapper's `mouseenter` only fires when the pointer arrives from outside. So
 * the pill dismissed itself 120ms after the pointer landed on it — the press it
 * exists for had to beat a timer.
 */

import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refChipElement, RICH_INPUT_SLOT } from './rich-editor'

const openExternalLink = vi.fn()
const openSessionRef = vi.fn()

vi.mock('@/lib/external-link', () => ({ openExternalLink: (url: string) => openExternalLink(url) }))
vi.mock('@/app/open-session', () => ({
  openSessionRef: (id: string, intent: string) => openSessionRef(id, intent)
}))

const { ComposerDirectiveActions } = await import('./directive-actions')

const pill = () => document.querySelector<HTMLElement>('[data-slot="composer-directive-action"]')

/** jsdom has no PointerEvent; MouseEvent carries everything these read. */
function pointer(target: Element | null, type: string, init: { pointerType?: string; relatedTarget?: Element | null }) {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget: init.relatedTarget ?? null })

  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' })

  act(() => {
    target?.dispatchEvent(event)
  })
}

function mountEditor(kind: string, value: string) {
  const editor = document.createElement('div')

  editor.dataset.slot = RICH_INPUT_SLOT
  editor.contentEditable = 'true'
  editor.append(refChipElement(kind, value))
  document.body.append(editor)

  const editorRef = createRef<HTMLElement>() as { current: HTMLElement | null }

  editorRef.current = editor
  render(<ComposerDirectiveActions editorRef={editorRef} />)

  return { chip: editor.querySelector<HTMLElement>('[data-ref-kind]')!, editor }
}

beforeEach(() => {
  vi.useFakeTimers()
  openExternalLink.mockClear()
  openSessionRef.mockClear()
})

afterEach(() => {
  cleanup()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('the composer directive action pill', () => {
  it('offers Open over a hovered url chip', () => {
    const { chip } = mountEditor('url', 'https://example.com/x')

    pointer(chip, 'pointerover', {})

    expect(pill()?.textContent).toContain('Open')
    expect(pill()?.dataset.value).toBe('https://example.com/x')
  })

  it('stays up while the pointer moves within the pill', () => {
    const { chip } = mountEditor('url', 'https://example.com/x')

    pointer(chip, 'pointerover', {})

    const button = pill()!.querySelector('button')!

    // Wrapper → button, then button → its icon: two moves that never leave the
    // pill, each of which used to schedule the hide.
    pointer(pill(), 'pointerout', { relatedTarget: button })
    pointer(button, 'pointerover', {})
    pointer(button, 'pointerout', { relatedTarget: button.querySelector('i.codicon') })

    act(() => void vi.advanceTimersByTime(400))

    expect(pill()).not.toBeNull()
  })

  it('runs the action on press without stealing the caret', () => {
    const { chip } = mountEditor('url', 'https://example.com/x')

    pointer(chip, 'pointerover', {})

    const button = pill()!.querySelector('button')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })

    act(() => {
      button.dispatchEvent(down)
      button.click()
    })

    expect(down.defaultPrevented).toBe(true)
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/x')
    expect(pill()).toBeNull()
  })

  it('opens a session ref beside the chat rather than over it', () => {
    const { chip } = mountEditor('session', 'work/abc123')

    pointer(chip, 'pointerover', {})
    act(() => void pill()!.querySelector('button')!.click())

    expect(openSessionRef).toHaveBeenCalledWith('abc123', 'tab')
  })

  it('hides shortly after the pointer leaves for something else', () => {
    const { chip } = mountEditor('url', 'https://example.com/x')

    pointer(chip, 'pointerover', {})
    pointer(chip, 'pointerout', { relatedTarget: document.body })

    act(() => void vi.advanceTimersByTime(200))

    expect(pill()).toBeNull()
  })

  it('ignores a chip belonging to another composer', () => {
    const { editor } = mountEditor('url', 'https://example.com/x')
    const other = document.createElement('div')

    other.append(refChipElement('url', 'https://elsewhere.test'))
    document.body.append(other)
    editor.remove()

    pointer(other.querySelector('[data-ref-kind]'), 'pointerover', {})

    expect(pill()).toBeNull()
  })

  it('leaves an inert kind alone', () => {
    const { chip } = mountEditor('file', 'src/main.tsx')

    pointer(chip, 'pointerover', {})

    expect(pill()).toBeNull()
  })

  // Touch has no hover: `pointerover`/`pointerout` bracket the tap itself, so
  // the mouse rules would flash the pill up and take it away 120ms after the
  // finger lifted — visible, and impossible to press.
  it('keeps the pill up after a tap until something dismisses it', () => {
    const { chip } = mountEditor('url', 'https://example.com/x')

    pointer(chip, 'pointerover', { pointerType: 'touch' })
    pointer(chip, 'pointerout', { pointerType: 'touch', relatedTarget: null })

    act(() => void vi.advanceTimersByTime(400))

    expect(pill()).not.toBeNull()

    act(() => void document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))

    expect(pill()).toBeNull()
  })
})
