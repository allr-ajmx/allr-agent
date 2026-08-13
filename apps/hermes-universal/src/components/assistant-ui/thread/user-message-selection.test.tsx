/**
 * A live highlight vs. the user bubble's click gestures (MJXHRM-406).
 *
 * The bubble IS the edit button, so every selection the user makes over it — or
 * anywhere else in the transcript — collides with a click. Three handlers
 * arbitrate that, and none of them had a test.
 *
 * THE DEFECT THIS PINS. The press handler used to cancel the pointer event's
 * default when a selection was live. Cancelling `pointerdown` suppresses the
 * compatibility mouse events, and mousedown's default is the only thing that
 * collapses a selection — so pressing a bubble while ANY text was highlighted
 * (typically in the reply above it) did nothing AND left the highlight standing,
 * which made the next press do nothing either. The bubble was dead until the
 * user clicked some other surface. Desktop never cancelled it; universal added
 * it, and only here.
 *
 * jsdom does not implement the selection collapse itself, so the middle block
 * asserts the CONTRACT (the press leaves its default alone) rather than the
 * engine behaviour. WebKitGTK confirmation is on the ticket's runtime list.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $reactionsEnabled } from '@/store/reactions-enabled'
import { onThreadEditOpen } from '@/store/thread-scroll'

vi.mock('@assistant-ui/react', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>

  return {
    ActionBarPrimitive: { Root: passthrough, Edit: passthrough },
    BranchPickerPrimitive: {
      Root: passthrough,
      Previous: passthrough,
      Next: passthrough,
      Number: () => <span>1</span>,
      Count: () => <span>1</span>
    },
    MessagePrimitive: { Root: passthrough },
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({
        message: { id: 'm1', content: [{ type: 'text', text: 'fix the login redirect' }] },
        thread: { isRunning: false, messages: [{ id: 'm1', role: 'user' }] }
      })
  }
})

vi.mock('@/hooks/use-resize-observer', () => ({ useResizeObserver: () => undefined }))

const { hasTextSelection, UserMessage } = await import('./user-message')

/** Highlight a node's contents for real — `hasTextSelection` reads the live
 *  Selection, so a stub would only assert the stub. */
function highlight(text = 'copy me'): HTMLElement {
  const node = document.createElement('span')

  node.textContent = text
  document.body.append(node)

  const range = document.createRange()

  range.selectNodeContents(node)

  const selection = window.getSelection()!

  selection.removeAllRanges()
  selection.addRange(range)

  return node
}

const bubble = () => screen.getByRole('button', { name: 'Edit message' })

/** jsdom has no PointerEvent; MouseEvent carries everything React reads. */
function press(target: Element, type: 'click' | 'contextmenu' | 'pointerdown'): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 })

  act(() => void target.dispatchEvent(event))

  return event
}

let editOpens = 0
let offEditOpen: (() => void) | null = null

beforeEach(() => {
  editOpens = 0
  offEditOpen = onThreadEditOpen(() => {
    editOpens += 1
  })
})

afterEach(() => {
  offEditOpen?.()
  offEditOpen = null
  cleanup()
  window.getSelection()?.removeAllRanges()
  $reactionsEnabled.set(false)
  document.body.replaceChildren()
})

describe('hasTextSelection', () => {
  it('is false with nothing highlighted', () => {
    expect(hasTextSelection()).toBe(false)
  })

  it('is true once the user has a live range', () => {
    highlight()

    expect(hasTextSelection()).toBe(true)
  })

  it('is false for a bare caret — a collapsed range is not a highlight', () => {
    const node = highlight()
    const range = document.createRange()

    range.setStart(node.firstChild!, 2)
    range.collapse(true)

    const selection = window.getSelection()!

    selection.removeAllRanges()
    selection.addRange(range)

    expect(hasTextSelection()).toBe(false)
  })
})

describe('pressing the bubble with a highlight already live', () => {
  it('leaves the press its default, so the stale highlight collapses', () => {
    render(<UserMessage />)
    // Highlighted in the reply above, which is the ordinary way to arrive here.
    highlight()

    const event = press(bubble(), 'pointerdown')

    // The fix. Cancelling this is what left the highlight standing and made the
    // bubble unpressable for as long as it stood.
    expect(event.defaultPrevented).toBe(false)
    // Still no edit-open notice: the press has not opened an editor.
    expect(editOpens).toBe(0)
  })

  it('announces the edit when there is nothing highlighted', () => {
    render(<UserMessage />)

    press(bubble(), 'pointerdown')

    expect(editOpens).toBe(1)
  })
})

describe('the click that finishes a drag-select', () => {
  it('is swallowed, so the editor never opens over a fresh highlight', () => {
    render(<UserMessage />)
    // A drag inside the bubble leaves the highlight live at click time — this
    // is the case the guard exists for.
    highlight()

    expect(press(bubble(), 'click').defaultPrevented).toBe(true)
  })

  it('goes through as a plain click when nothing is highlighted', () => {
    render(<UserMessage />)

    expect(press(bubble(), 'click').defaultPrevented).toBe(false)
  })
})

describe('right-click', () => {
  // Asserted first so the absence below is an absence of something that CAN be
  // there: `❤️` is QUICK_REACTIONS[0], rendered only by an open picker.
  it('raises the reaction picker when nothing is highlighted', () => {
    $reactionsEnabled.set(true)
    render(<UserMessage />)

    expect(press(bubble(), 'contextmenu').defaultPrevented).toBe(true)
    expect(screen.getByRole('button', { name: '❤️' })).toBeInTheDocument()
  })

  it('keeps the native Copy menu while text is highlighted', () => {
    $reactionsEnabled.set(true)
    render(<UserMessage />)
    highlight()

    // Not cancelled → the browser draws its own menu, which is the only route
    // to Copy for a mouse user; and the picker that would have covered it stays
    // shut.
    expect(press(bubble(), 'contextmenu').defaultPrevented).toBe(false)
    expect(screen.queryByRole('button', { name: '❤️' })).toBeNull()
  })

  it('is left entirely alone while reactions are off', () => {
    render(<UserMessage />)

    // No handler at all, so the native menu is the behaviour on both paths.
    expect(press(bubble(), 'contextmenu').defaultPrevented).toBe(false)
  })
})
