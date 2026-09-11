/**
 * The composer's line breaks — who is allowed to delete one, and who is not.
 *
 * `normalizeComposerEditorDom` exists to throw away the block wrappers and
 * trailing `<br>`s a contenteditable invents when you edit around a
 * `contenteditable=false` chip. Those serialize as `\n` and visibly grow the
 * composer, so they have to go. The hazard is that a line break the USER asked
 * for is the same node, and for a long time the only thing separating the two
 * was shape — "a `<br>` after real text is real; a trailing block wrapper is
 * junk" — which is a statement about Chromium rather than about the web.
 *
 * WebKit (WKWebView on macOS/iOS, WebKitGTK on Linux) reaches for a block
 * wrapper where Chromium reaches for a bare `<br>`, so on those engines the junk
 * rule matched the newline the user had just typed and deleted it on the very
 * next flush. That is the whole of "Shift+Enter does nothing on macOS"
 * (MJXHRM-A3), and it is why the composer now inserts its own TAGGED break
 * instead of inferring one: ownership is a fact about the node, not a guess
 * about the engine.
 *
 * These cases pin the discrimination in both directions. A regression that
 * loosened the tag check would fail the "junk is still junk" cases; one that
 * tightened the shape rules again would fail the WebKit ones.
 */

import { describe, expect, it } from 'vitest'

import {
  composerBreakElement,
  composerHtml,
  composerPlainText,
  insertComposerLineBreak,
  normalizeComposerEditorDom,
  renderComposerContents,
  RICH_INPUT_SLOT
} from './rich-editor'

const CHIP = '<span contenteditable="false" data-ref-text="@file:`a.ts`" data-ref-id="a.ts">a.ts</span>'

/** An editor carrying the composer's own slot marker — `composerPlainText`
 *  appends a trailing newline to any OTHER block element, so a scratch div
 *  without it measures one character long. */
function editorWith(html: string): HTMLElement {
  const editor = document.createElement('div')

  editor.dataset.slot = RICH_INPUT_SLOT
  editor.innerHTML = html

  return editor
}

/** Put the caret at the very end of `editor`, as a real focused edit would. */
function caretAtEnd(editor: HTMLElement): void {
  document.body.append(editor)

  const range = document.createRange()

  range.selectNodeContents(editor)
  range.collapse(false)

  const selection = window.getSelection()

  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('a break the composer inserted survives normalization', () => {
  it('keeps a tagged break at the end of the text', () => {
    // The shape Chromium leaves for Shift+Enter, and the shape we now emit
    // everywhere. It already survived; it must keep surviving.
    const editor = editorWith(`hello${composerBreakElement().outerHTML}`)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('hello\n')
  })

  it('keeps a tagged break straight after a chip', () => {
    // Engine-independent, and the case that made this a bug on Windows too: the
    // "trailing <br> after a chip is a phantom line" rule matched a newline the
    // user typed immediately after picking an @file: completion.
    const editor = editorWith(`${CHIP}${composerBreakElement().outerHTML}`)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('@file:`a.ts`\n')
  })

  it('keeps a tagged break as the only thing in the editor', () => {
    // Shift+Enter as the first keystroke into an empty composer. `!prev` used to
    // send it straight to the phantom branch.
    const editor = editorWith(composerBreakElement().outerHTML)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('\n')
  })

  it('keeps a tagged break the webview has wrapped in a block', () => {
    // The WebKit shape. The wrapper is the engine's; the break inside it is
    // ours, so the wrapper is not "blank" and the whole node stays.
    const editor = editorWith(`hello<div>${composerBreakElement().outerHTML}</div>`)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toContain('\n')
  })
})

describe('junk the webview invented is still deleted', () => {
  it('drops an untagged trailing block wrapper', () => {
    // The phantom "new line" left behind by backspacing around a chip. Identical
    // in shape to WebKit's Shift+Enter result — which is exactly why the tag,
    // and not the shape, is what decides.
    const editor = editorWith(`${CHIP}<div><br></div>`)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('@file:`a.ts`')
  })

  it('drops an untagged trailing <br> after a chip', () => {
    const editor = editorWith(`${CHIP}<br>`)

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('@file:`a.ts`')
  })

  it('drops an untagged trailing <br> in an otherwise empty editor', () => {
    const editor = editorWith('<br>')

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('')
  })
})

describe('a draft round-trips its newlines', () => {
  it('survives text → DOM → text', () => {
    // The repaint path: a restored draft, an undo step, a programmatic insert.
    // Every break it paints has to be one normalization will not then eat, or a
    // multi-line draft loses a line each time it is put back.
    const text = 'first\nsecond\n\nfourth'
    const editor = editorWith('')

    renderComposerContents(editor, text)
    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe(text)
  })

  it('survives text → composerHtml → text', () => {
    // The string serializer has to agree with the node builder about tagging.
    // It did not, and a draft repainted through it lost its newlines on the next
    // flush.
    const text = 'note\nabout @file:`a.ts`\nand more'
    const editor = editorWith(composerHtml(text))

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe(text)
  })

  it('keeps a trailing newline through composerHtml', () => {
    const editor = editorWith(composerHtml('hello\n'))

    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('hello\n')
  })
})

describe('insertComposerLineBreak', () => {
  it('inserts at the caret and survives the flush that follows', () => {
    const editor = editorWith('hello')

    caretAtEnd(editor)

    expect(insertComposerLineBreak(editor)).toBe(true)

    // What `flushEditorToDraft` does on the very next tick — the step that used
    // to delete the newline before the user saw it.
    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('hello\n')

    editor.remove()
  })

  it('appends when the caret is not in this editor', () => {
    // A programmatic call must not silently do nothing.
    const editor = editorWith('hello')

    expect(insertComposerLineBreak(editor)).toBe(true)
    normalizeComposerEditorDom(editor)

    expect(composerPlainText(editor)).toBe('hello\n')
  })

  it('produces the same text on both engine shapes', () => {
    // The point of owning the gesture: one DOM, so one answer, everywhere.
    const chromiumish = editorWith('hello')
    const webkitish = editorWith('hello')

    insertComposerLineBreak(chromiumish)
    insertComposerLineBreak(webkitish)
    normalizeComposerEditorDom(chromiumish)
    normalizeComposerEditorDom(webkitish)

    expect(composerPlainText(chromiumish)).toBe(composerPlainText(webkitish))
  })
})
