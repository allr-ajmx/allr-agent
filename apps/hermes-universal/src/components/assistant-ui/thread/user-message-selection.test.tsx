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
 *
 * THE OTHER HALF (MJXHRM-361). None of those handlers decide whether a drag
 * highlights anything in the first place — the cascade in styles.css does, and
 * <body> says `user-select: none` because this is an app, not a document. The
 * last block reads that cascade for the elements it governs.
 */

/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

// ── The CSS half ────────────────────────────────────────────────────────────
//
// The bubble is a <button>, which is the one element type the stylesheet turns
// selection OFF for — so `button { user-select: none }` and the override that
// re-enables it inside `[data-slot='aui_user-message-root']` are a single unit,
// and the thing worth pinning is the OUTCOME of the cascade rather than the
// presence of a line of CSS. Universal shipped neither half for a while, which
// computed the same answer for the bubble and a different one for every other
// selectable surface around it (buttons and images inside a reply).
//
// Vitest stubs every css import (see overlay-z-order.test.tsx), so the sheet is
// read off disk. What follows resolves ONE property over the rules in that one
// file: it is not a browser, and it ignores Tailwind's own utilities — none of
// the elements below carry a `select-*` class. It cannot prove that WebKitGTK
// honours the result; that is the runtime checklist's job.
const STYLESHEET = readFileSync(join(__dirname, '..', '..', '..', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

interface CssRule {
  declarations: Map<string, string>
  order: number
  selectors: string[]
}

const RULES: CssRule[] = (() => {
  const rules: CssRule[] = []

  // Innermost blocks only: `[^{}]` cannot cross a brace, so an at-rule wrapper
  // (`@layer base { … }`) contributes its children and never itself.
  for (const [, selectorList, body] of STYLESHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>()

    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')

      if (colon !== -1) {
        declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim())
      }
    }

    rules.push({
      declarations,
      order: rules.length,
      selectors: selectorList
        .split(',')
        .map(selector => selector.trim())
        .filter(Boolean)
    })
  }

  return rules
})()

/** a·b·c flattened into one number. `:not()` takes its argument's specificity,
 *  which falls out of counting the attribute selectors written inside it. */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!:)(?!not\b)[\w-]+/g)?.length ?? 0
  const types = selector.match(/(?:^|[\s>+~])[a-z]+/g)?.length ?? 0

  return ids * 10000 + classes * 100 + types
}

/** Pseudo-element selectors throw in the DOM matcher, and could not match an
 *  element anyway. */
function matchesSelector(element: Element, selector: string): boolean {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

/** The declaration that wins ON this element — highest specificity, then last
 *  one written. `null` when nothing in the sheet targets it. */
function declaredOn(element: Element, property: string): null | string {
  let winner: null | { order: number; specificity: number; value: string } = null

  for (const rule of RULES) {
    const value = rule.declarations.get(property)

    if (value === undefined) {
      continue
    }

    for (const selector of rule.selectors) {
      if (!matchesSelector(element, selector)) {
        continue
      }

      const rank = specificity(selector)

      if (!winner || rank > winner.specificity || (rank === winner.specificity && rule.order > winner.order)) {
        winner = { order: rule.order, specificity: rank, value }
      }
    }
  }

  return winner?.value ?? null
}

/** The value an element ends up with: its own declaration if it has one, else
 *  the nearest ancestor's. (WebKit inherits `-webkit-user-select` outright; the
 *  spec arrives at the same answer for `none`/`text` via `auto`'s used value.) */
function userSelect(element: Element): string {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const declared = declaredOn(node, 'user-select')

    if (declared) {
      return declared
    }
  }

  return 'auto'
}

/** Markup that lives elsewhere in the app, mounted where the cascade can see
 *  it. Each fixture names its source so it can be checked against the real one. */
function mount(markup: string): HTMLElement {
  const host = document.createElement('div')

  host.innerHTML = markup
  document.body.append(host)

  return host.firstElementChild as HTMLElement
}

describe('the cascade the guard is paired with', () => {
  it('starts from a shell that is not selectable at all', () => {
    // The premise for everything below: without a carve-out, nothing highlights.
    expect(userSelect(mount('<div>chrome</div>'))).toBe('none')
  })

  it('leaves the sent bubble selectable even though it is a <button>', () => {
    render(<UserMessage />)

    // Reachability: the override is a DESCENDANT selector. Move the data-slot
    // onto the button itself and it stops matching, and `button { none }` wins
    // in silence.
    expect(bubble().closest("[data-slot='aui_user-message-root']")).not.toBeNull()
    expect(userSelect(bubble())).toBe('text')
  })

  it('keeps the prompt text inside the bubble selectable', () => {
    render(<UserMessage />)

    expect(userSelect(bubble().querySelector("[data-slot='aui_user-message-text']")!)).toBe('text')
  })

  it('turns selection off on a button INSIDE a reply, where the prose around it is on', () => {
    // assistant-message.tsx renders the dismiss-error control inside the content
    // slot. A drag across the reply must not sweep its label into the clipboard.
    const content = mount(
      '<div data-slot="aui_assistant-message-content"><p>reply</p><button type="button">Dismiss</button></div>'
    )

    expect(userSelect(content.querySelector('p')!)).toBe('text')
    expect(userSelect(content.querySelector('button')!)).toBe('none')
  })

  it('keeps an editable composer selectable under the shell-wide none', () => {
    // composer/index.tsx and user-edit-composer.tsx both render the editor as
    // `data-slot="composer-rich-input"` on a contenteditable div.
    expect(userSelect(mount('<div contenteditable="true" data-slot="composer-rich-input">draft</div>'))).toBe('text')
  })

  it('does not carve out a DISABLED composer, which renders contenteditable="false"', () => {
    expect(userSelect(mount('<div contenteditable="false" data-slot="composer-rich-input">draft</div>'))).toBe('none')
  })

  it('takes images out of the selection and out of the drag gesture', () => {
    const content = mount('<div data-slot="aui_assistant-message-content"><p>look</p><img alt="" src="x.png"></div>')

    const image = content.querySelector('img')!

    expect(userSelect(image)).toBe('none')
    // Without this a press on the picture starts a native image drag, so a
    // drag-select that begins on one never selects anything.
    expect(declaredOn(image, '-webkit-user-drag')).toBe('none')
  })

  it('never lets the painted placeholder into a selection', () => {
    // It is a ::before, so no element can carry it — assert the rule instead.
    // The selector appears twice in the sheet (the composer section paints it,
    // the selection section disarms it), so this asks whether ANY of them does.
    const guards = RULES.filter(rule => rule.selectors.includes("[data-slot='composer-rich-input']:empty::before"))

    expect(guards.length).toBeGreaterThan(0)
    expect(guards.map(rule => rule.declarations.get('user-select'))).toContain('none')
  })
})
