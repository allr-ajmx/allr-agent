/**
 * Helpers for the contenteditable composer surface: serialize refs to chip
 * HTML, walk the DOM back to plain `@kind:value` text, and place the caret.
 *
 * Chip values are always wrapped in backticks/quotes so REF_RE stops at the
 * fence — without that, typing after a chip would get re-absorbed on the next
 * plain-text round-trip.
 */
import {
  directiveIconElement,
  directiveIconSvg,
  formatRefValue,
  refAttrsHtml,
  refChipLabel,
  type SlashChipKind,
  slashIconElement
} from '@/components/assistant-ui/directive-text'
import { referenceKind, referenceRe } from '@/components/assistant-ui/reference-kinds'

import { slashCommandMatches, type SlashCommandScanOptions } from './slash-refs'

export const RICH_INPUT_SLOT = 'composer-rich-input'

/** @see referenceRe — the shared pattern every surface recognises a reference
 *  with. Module-level `/g` regexes carry `lastIndex`, so call sites reset it. */
export const REF_RE = referenceRe()

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, ch => ESC[ch] || ch)
}

export function unquoteRef(raw: string) {
  const head = raw[0]
  const tail = raw[raw.length - 1]
  const quoted = (head === '`' && tail === '`') || (head === '"' && tail === '"') || (head === "'" && tail === "'")

  return quoted ? raw.slice(1, -1) : raw.replace(/[,.;!?]+$/, '')
}

/** Always-quote variant of formatRefValue — chips need a fence even for safe values. */
export function quoteRefValue(value: string) {
  if (!value.includes('`')) {
    return `\`${value}\``
  }

  if (!value.includes('"')) {
    return `"${value}"`
  }

  if (!value.includes("'")) {
    return `'${value}'`
  }

  return formatRefValue(value)
}

export function refChipHtml(kind: string, rawValue: string, displayLabel?: string) {
  const id = unquoteRef(rawValue)
  const text = `@${kind}:${quoteRefValue(id)}`
  const label = displayLabel || refChipLabel(kind, id)

  return `<span contenteditable="false" title="${escapeHtml(id)}" data-ref-text="${escapeHtml(text)}" data-ref-id="${escapeHtml(id)}" data-ref-kind="${escapeHtml(kind)}" ${refAttrsHtml(kind)}>${directiveIconSvg(kind)}${escapeHtml(label)}</span>`
}

export function refChipElement(kind: string, rawValue: string, displayLabel?: string) {
  const id = unquoteRef(rawValue)
  const text = `@${kind}:${quoteRefValue(id)}`
  const chip = document.createElement('span')

  chip.contentEditable = 'false'
  chip.title = id
  chip.dataset.refText = text
  chip.dataset.refId = id
  chip.dataset.refKind = kind
  chip.className = 'ref'
  chip.dataset.ref = referenceKind(kind)
  chip.append(directiveIconElement(kind), document.createTextNode(displayLabel || refChipLabel(kind, id)))

  return chip
}

/** A non-editable reference for a picked slash command (`/skin nous`, `/tropes`).
 *  `data-ref-text` carries the literal command so `composerPlainText` round-trips
 *  it back to the exact text that gets submitted. */
export function slashChipElement(command: string, kind: SlashChipKind, label?: string) {
  const chip = document.createElement('span')

  chip.contentEditable = 'false'
  chip.dataset.refText = command
  chip.dataset.slashKind = kind
  chip.className = 'ref'
  chip.dataset.ref = kind
  chip.append(slashIconElement(kind), document.createTextNode(label || command))

  return chip
}

/**
 * Marks a `<br>` the COMPOSER put there, as opposed to one the webview's editing
 * pipeline invented.
 *
 * The two are indistinguishable in the DOM and must be treated as opposites:
 * a line break the user asked for is content, and a phantom block/`<br>` the
 * engine leaves behind after editing around a `contenteditable=false` chip is
 * junk that serializes as a spurious `\n` and visibly grows the composer.
 * `normalizeComposerEditorDom` used to tell them apart by SHAPE — "a `<br>` after
 * real text is real, a trailing block wrapper is phantom" — which is a statement
 * about Chromium, not about the web: WebKit (WKWebView on macOS/iOS, WebKitGTK
 * on Linux) reaches for a block wrapper where Chromium reaches for a bare `<br>`,
 * so on those engines the phantom rule matched the user's own newline and
 * deleted it on the very next flush (MJXHRM-A3: "Shift+Enter does nothing on
 * macOS").
 *
 * Owning the gesture removes the guess entirely. Every break this module emits
 * carries the marker, so "did we put this here?" is a question with an answer
 * rather than a heuristic, and it reads the same on every engine.
 */
const COMPOSER_BREAK_DATA_ATTR = 'data-composer-break'

/** True for a `<br>` the composer itself inserted (a real, user-intended line
 *  break) — never for one the webview's editing pipeline left behind. */
export function isComposerBreak(node: Node | null | undefined): boolean {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return false
  }

  const el = node as HTMLElement

  return el.tagName === 'BR' && el.dataset.composerBreak !== undefined
}

/** A tagged `<br>` — the only kind this module ever renders. */
export function composerBreakElement(): HTMLBRElement {
  const br = document.createElement('br')

  br.dataset.composerBreak = ''

  return br
}

/** The HTML form of `composerBreakElement`, for the string serializer. */
const COMPOSER_BREAK_HTML = `<br ${COMPOSER_BREAK_DATA_ATTR}="">`

function appendTextWithBreaks(target: DocumentFragment | HTMLElement, text: string) {
  const lines = text.split('\n')

  lines.forEach((line, index) => {
    if (index > 0) {
      target.append(composerBreakElement())
    }

    if (line) {
      target.append(document.createTextNode(line))
    }
  })
}

/** Every span of `text` that renders as a chip, in source order. */
function chipSpans(text: string, options: SlashCommandScanOptions) {
  REF_RE.lastIndex = 0

  const refs = Array.from(text.matchAll(REF_RE)).map(match => {
    const start = match.index ?? 0

    return { end: start + match[0].length, node: () => refChipElement(match[1] || 'file', match[2] || ''), start }
  })

  const commands = slashCommandMatches(text, options).map(match => ({
    end: match.end,
    node: () => slashChipElement(match.command, match.kind),
    start: match.start
  }))

  return [...refs, ...commands].sort((a, b) => a.start - b.start)
}

/** Build the chip/text DOM for `text`. Directives hydrate back to their pills —
 *  `@kind:value` refs and `/command` invocations both — so text that arrives
 *  whole (a paste, a restored draft, an undo step, a rebuilt line) carries the
 *  same chips the typed path would have committed. */
export function appendComposerContents(
  target: DocumentFragment | HTMLElement,
  text: string,
  options: SlashCommandScanOptions = {}
) {
  let cursor = 0

  for (const span of chipSpans(text, options)) {
    // A `@` ref wins an overlap: a command token can't contain an `@`, so the
    // only way spans collide is a slash inside a quoted ref value
    // (`` @url:`a /clean` ``), which belongs to that value.
    if (span.start < cursor) {
      continue
    }

    appendTextWithBreaks(target, text.slice(cursor, span.start))
    target.append(span.node())
    cursor = span.end
  }

  appendTextWithBreaks(target, text.slice(cursor))
}

export function renderComposerContents(target: HTMLElement, text: string, options?: SlashCommandScanOptions) {
  target.replaceChildren()

  // Defaults to live editing, where a token ending the text is still being
  // typed (`/wor`) and must stay editable. Callers repainting inert text (a
  // restored draft, a sent message opened for edit) pass `trailingCommitted`.
  appendComposerContents(target, text, options)
}

/** Caret range when the selection lives inside `editor`; else null. */
function composerSelectionRange(editor: HTMLElement) {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null

  if (!selection || !range || !editor.contains(range.commonAncestorContainer)) {
    return null
  }

  return { range, selection }
}

/** Serialized text from the editor's start up to (`container`, `offset`).
 *
 *  Chips are ATOMIC here: each contributes an object-replacement placeholder
 *  rather than leaking its label text, and a <br> contributes a newline. That
 *  makes a chip edge read as a token boundary, which is what directive
 *  recognition needs. */
export function serializeTextBefore(editor: HTMLElement, container: Node, offset: number): string {
  const probe = document.createRange()

  probe.selectNodeContents(editor)
  probe.setEnd(container, offset)

  const scratch = document.createElement('div')

  scratch.append(probe.cloneContents())

  for (const chip of scratch.querySelectorAll('[data-ref-text]')) {
    chip.replaceWith('\uFFFC')
  }

  for (const br of scratch.querySelectorAll('br')) {
    br.replaceWith('\n')
  }

  return scratch.textContent ?? ''
}

/** True when the insertion point starts a token — the editor's start, or after
 *  whitespace or a chip. `foo` + a pasted `/clean` is `foo/clean`, not a
 *  command; `foo ` + the same paste is. */
function atTokenBoundary(editor: HTMLElement, range: Range | null): boolean {
  // No caret means the insert lands at the end, so the question is about the
  // editor's last character either way.
  const before = range
    ? serializeTextBefore(editor, range.startContainer, range.startOffset)
    : serializeTextBefore(editor, editor, editor.childNodes.length)

  const last = before.slice(-1)

  return !last || /[\s\uFFFC]/.test(last)
}

/** A Range covering the `length` characters immediately before a collapsed
 *  caret, or null when they aren't contiguous text. Spans text nodes: the
 *  webview fragments text around `contenteditable=false` chips on every edit,
 *  so a check that demanded the whole token inside ONE text node would degrade
 *  to a full re-render as soon as a chip existed anywhere in the line. */
export function rangeBeforeCaret(editor: HTMLElement, length: number): Range | null {
  const hit = composerSelectionRange(editor)

  if (!hit?.range.collapsed || length <= 0) {
    return null
  }

  let node: Node | null = hit.range.startContainer
  let offset = hit.range.startOffset

  // An element-positioned caret (common right after programmatic caret moves)
  // resolves to the end of the text node before it. A chip or <br> there means
  // no text token precedes the caret — bail rather than guess.
  if (node.nodeType !== Node.TEXT_NODE) {
    node = node.childNodes[offset - 1] ?? null

    if (node?.nodeType !== Node.TEXT_NODE) {
      return null
    }

    offset = (node.textContent || '').length
  }

  let startNode = node as Text
  let startOffset = offset
  let remaining = length

  while (remaining > 0) {
    if (startOffset >= remaining) {
      startOffset -= remaining
      remaining = 0

      break
    }

    remaining -= startOffset

    const prev: Node | null = startNode.previousSibling

    if (prev?.nodeType !== Node.TEXT_NODE) {
      return null
    }

    startNode = prev as Text
    startOffset = (prev.textContent || '').length
  }

  const range = document.createRange()

  range.setStart(startNode, startOffset)
  range.setEnd(hit.range.startContainer, hit.range.startOffset)

  return range
}

/** Swap the `length` characters immediately before a collapsed caret for
 *  `fragment`, leaving the caret after it. Returns whether it ran. */
export function replaceBeforeCaret(editor: HTMLElement, length: number, fragment: DocumentFragment) {
  const range = rangeBeforeCaret(editor, length)

  if (!range) {
    return false
  }

  const tail = fragment.lastChild

  range.deleteContents()
  range.insertNode(fragment)

  if (tail) {
    range.setStartAfter(tail)
  }

  range.collapse(true)

  const selection = window.getSelection()

  selection?.removeAllRanges()
  selection?.addRange(range)

  return true
}

/** Insert text at the caret (replacing any selection), with any directives in
 *  it landing as chips. Pastes use this instead of `execCommand('insertText')`
 *  — the webview's editing pipeline is ~O(n²) on large multiline blobs.
 *
 *  The text arrives whole rather than typed, so a `/command` ending it is
 *  complete rather than half-written and chips like the rest.
 *
 *  `consumeBefore` characters immediately before the caret are swallowed by the
 *  insert. That's how a paste into an open `@url:` scope replaces the scope
 *  instead of stacking on it (`@url:@url:\`https://…\``). */
export function insertComposerContentsAtCaret(editor: HTMLElement, text: string, consumeBefore = 0) {
  const scoped = consumeBefore > 0 ? rangeBeforeCaret(editor, consumeBefore) : null

  if (scoped) {
    scoped.deleteContents()
    scoped.collapse(true)

    const selection = window.getSelection()

    selection?.removeAllRanges()
    selection?.addRange(scoped)
  }

  const hit = composerSelectionRange(editor)
  const fragment = document.createDocumentFragment()

  // Before measuring the boundary — a replaced selection puts the insertion
  // point where the selection started, not where it ended.
  if (hit) {
    hit.range.deleteContents()
  }

  appendComposerContents(fragment, text, {
    boundaryBefore: atTokenBoundary(editor, hit?.range ?? null),
    trailingCommitted: true
  })

  // A slash pill ending the insert gets the trailing space the typed commit
  // path appends, or the next full re-render reads it as a half-typed token
  // and demotes it. `@` refs need no marker — REF_RE re-chips them either way.
  if ((fragment.lastChild as HTMLElement | null)?.dataset?.slashKind) {
    fragment.append(document.createTextNode(' '))
  }

  const tail = fragment.lastChild

  if (hit) {
    hit.range.insertNode(fragment)
  } else {
    editor.append(fragment)
  }

  if (tail) {
    const caret = document.createRange()
    caret.setStartAfter(tail)
    caret.collapse(true)
    const selection = hit?.selection ?? window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)
  }
}

/**
 * Insert ONE user-intended line break at the caret (replacing any selection),
 * leaving the caret after it. Returns whether it ran.
 *
 * This is what Shift+Enter does, instead of letting the webview's own
 * `insertLineBreak` do it. The engines do not agree on the DOM they produce for
 * that keystroke — Chromium leaves a bare `<br>`, WebKit a `<div><br></div>` —
 * and the normalizer downstream has to decide which trailing nodes are the
 * user's and which are the engine's leftovers. Emitting the break ourselves
 * makes that decision trivial and identical everywhere: it is ours, it is
 * tagged, it stays.
 *
 * Falls back to appending when the caret is not in this editor, so a
 * programmatic call cannot silently do nothing.
 */
export function insertComposerLineBreak(editor: HTMLElement): boolean {
  const hit = composerSelectionRange(editor)
  const br = composerBreakElement()

  if (hit) {
    hit.range.deleteContents()
    hit.range.insertNode(br)
  } else {
    editor.append(br)
  }

  const caret = document.createRange()

  caret.setStartAfter(br)
  caret.collapse(true)

  const selection = hit?.selection ?? window.getSelection()

  selection?.removeAllRanges()
  selection?.addRange(caret)

  return true
}

/** Insert plain text at the caret (replacing any selection), with no directive
 *  recognition — for text that must land literally. */
export function insertPlainTextAtCaret(editor: HTMLElement, text: string) {
  const hit = composerSelectionRange(editor)
  const fragment = document.createDocumentFragment()

  appendTextWithBreaks(fragment, text)

  const tail = fragment.lastChild

  if (hit) {
    hit.range.deleteContents()
    hit.range.insertNode(fragment)
  } else {
    editor.append(fragment)
  }

  if (tail) {
    const caret = document.createRange()
    caret.setStartAfter(tail)
    caret.collapse(true)
    const selection = hit?.selection ?? window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caret)
  }
}

/** Backspace at a collapsed caret immediately after a chip: delete the chip AND
 *  the single trailing space we auto-insert after it, atomically — so removing a
 *  directive never strands an orphaned space (the contenteditable-driven cleanup
 *  was unreliable). Returns whether it ran. */
export function deleteChipBeforeCaret(editor: HTMLElement): boolean {
  const hit = composerSelectionRange(editor)

  if (!hit || !hit.range.collapsed) {
    return false
  }

  const { startContainer, startOffset } = hit.range
  let chip: ChildNode | null = null

  if (startContainer === editor) {
    chip = startOffset > 0 ? editor.childNodes[startOffset - 1] : null
  } else if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
    chip = startContainer.previousSibling
  }

  if (chip?.nodeType !== Node.ELEMENT_NODE || !(chip as HTMLElement).dataset.refText) {
    return false
  }

  const after = chip.nextSibling
  chip.remove()

  // Drop the auto-inserted trailing space; keep any real following text.
  if (after?.nodeType === Node.TEXT_NODE) {
    const text = after.textContent ?? ''

    if (text === ' ') {
      after.remove()
    } else if (text.startsWith(' ')) {
      after.textContent = text.slice(1)
    }
  }

  const caret = document.createRange()

  if (after?.isConnected) {
    caret.setStartBefore(after)
  } else {
    caret.selectNodeContents(editor)
    caret.collapse(false)
  }

  caret.collapse(true)
  hit.selection.removeAllRanges()
  hit.selection.addRange(caret)

  return true
}

/** Remove a non-collapsed selection in-editor. Skips collapsed carets so word/
 *  line delete (Opt/Cmd+Backspace) stays native. Returns whether anything ran. */
export function deleteSelectionInEditor(editor: HTMLElement) {
  const hit = composerSelectionRange(editor)

  if (!hit || hit.range.collapsed) {
    return false
  }

  hit.range.deleteContents()
  hit.range.collapse(true)
  hit.selection.removeAllRanges()
  hit.selection.addRange(hit.range)

  return true
}

/** Serialize a draft string into chip-HTML for the contenteditable surface.
 *
 *  Breaks are TAGGED, exactly as `appendTextWithBreaks` tags the ones it builds
 *  as nodes. The two serializers have to agree: a draft repainted through this
 *  one and then normalized would otherwise have its newlines read as the
 *  webview's leftovers and stripped — the restored draft would lose a line every
 *  time it was put back. */
export function composerHtml(text: string) {
  let cursor = 0
  let html = ''

  REF_RE.lastIndex = 0

  const withBreaks = (slice: string) => escapeHtml(slice).replace(/\n/g, COMPOSER_BREAK_HTML)

  for (const match of text.matchAll(REF_RE)) {
    const index = match.index ?? 0
    html += withBreaks(text.slice(cursor, index))
    html += refChipHtml(match[1] || 'file', match[2] || '')
    cursor = index + match[0].length
  }

  return html + withBreaks(text.slice(cursor))
}

/** Walk a DOM subtree back to the plain `@kind:value` text it represents. */
export function composerPlainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || ''
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const el = node as HTMLElement

  if (el.dataset.refText) {
    return el.dataset.refText
  }

  if (el.tagName === 'BR') {
    return '\n'
  }

  const text = Array.from(node.childNodes).map(composerPlainText).join('')
  const block = el.tagName === 'DIV' || el.tagName === 'P'

  return block && text && el.dataset.slot !== RICH_INPUT_SLOT ? `${text}\n` : text
}

export function placeCaretEnd(element: HTMLElement) {
  const range = document.createRange()
  const selection = window.getSelection()

  range.selectNodeContents(element)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** The caret's offset in `composerPlainText` coordinates, so it can be restored
 *  after the editor is re-rendered from text (undo/redo). A chip counts as its
 *  whole `@kind:value` text — the same units the snapshot measures. */
export function caretOffsetInEditor(editor: HTMLElement): number {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null

  if (!range || !editor.contains(range.commonAncestorContainer)) {
    return composerPlainText(editor).length
  }

  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)

  // The scratch container must carry the editor's slot marker: composerPlainText
  // appends a trailing "\n" to any other block element, which would inflate
  // every offset by one and land the restored caret a character late.
  const container = document.createElement('div')
  container.dataset.slot = RICH_INPUT_SLOT
  container.append(before.cloneContents())

  return composerPlainText(container).length
}

/** Place the caret `offset` characters into the editor, in the same
 *  `composerPlainText` coordinates `caretOffsetInEditor` reports. Lands after a
 *  chip it would otherwise split, since a chip is a single atomic unit. */
export function placeCaretAtOffset(editor: HTMLElement, offset: number) {
  const selection = window.getSelection()

  if (!selection) {
    return
  }

  let remaining = offset

  const walk = (node: Node): Range | null => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child.textContent || '').length

        if (remaining <= length) {
          const range = document.createRange()
          range.setStart(child, remaining)
          range.collapse(true)

          return range
        }

        remaining -= length

        continue
      }

      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue
      }

      const el = child as HTMLElement

      // Chips and <br> are atomic: consume their serialized length whole.
      if (el.dataset.refText || el.tagName === 'BR') {
        const length = el.dataset.refText ? el.dataset.refText.length : 1

        if (remaining < length) {
          const range = document.createRange()
          range.setStartBefore(el)
          range.collapse(true)

          return range
        }

        remaining -= length

        continue
      }

      const hit = walk(el)

      if (hit) {
        return hit
      }
    }

    return null
  }

  const range = walk(editor)

  if (range) {
    selection.removeAllRanges()
    selection.addRange(range)

    return
  }

  placeCaretEnd(editor)
}

/** Nothing but a PHANTOM break / whitespace (recursively) — i.e. no real text,
 *  no chip, and no break the composer itself put there.
 *
 *  A tagged break is content by definition: the user pressed Shift+Enter and we
 *  wrote it down. Without that exception a WebKit-shaped `<div><br></div>` and a
 *  Chromium-shaped bare `<br>` are the same node to this predicate, so the only
 *  thing separating "the newline you just typed" from "junk the engine left"
 *  would be which engine you happen to be running. */
function isBlankNode(node: ChildNode | null): boolean {
  if (!node) {
    return false
  }

  if (node.nodeName === 'BR') {
    return !isComposerBreak(node)
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return !(node.textContent || '').trim()
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement

    return !el.dataset.refText && Array.from(el.childNodes).every(isBlankNode)
  }

  return false
}

/** Drop contenteditable junk that serializes as `\n` and falsely expands the
 *  composer. Editing around a contenteditable=false chip makes the webview wrap
 *  the remainder in stray block <div>s / trailing <br>s — none of which our own
 *  rendering emits (we use text nodes + tagged <br> + chips).
 *
 *  Line breaks the COMPOSER inserted are preserved, and that is now a property of
 *  the node rather than of its position: `insertComposerLineBreak` tags every
 *  break it writes, so Shift+Enter survives here whether the engine would have
 *  represented it as a bare `<br>` (Chromium), as a trailing `<div><br></div>`
 *  (WebKit), or right after a chip — three shapes that all used to be read as
 *  phantoms and deleted on the next flush. Untagged leftovers are still junk and
 *  still go. */
export function normalizeComposerEditorDom(editor: HTMLElement) {
  // A trailing block wrapper holding only a break/whitespace is the phantom
  // "new line" the webview adds after a chip on backspace — drop it.
  const tailBlock = editor.lastChild as HTMLElement | null

  if (
    tailBlock?.nodeType === Node.ELEMENT_NODE &&
    (tailBlock.tagName === 'DIV' || tailBlock.tagName === 'P') &&
    isBlankNode(tailBlock)
  ) {
    editor.removeChild(tailBlock)
  }

  // Unwrap a lone block wrapper back to inline content.
  if (editor.childNodes.length === 1 && editor.firstChild?.nodeType === Node.ELEMENT_NODE) {
    const wrapper = editor.firstChild as HTMLElement

    if ((wrapper.tagName === 'DIV' || wrapper.tagName === 'P') && wrapper.dataset.slot !== RICH_INPUT_SLOT) {
      editor.replaceChildren(...Array.from(wrapper.childNodes))
    }
  }

  // A trailing <br> right after a chip / only whitespace is a phantom line —
  // UNLESS we put it there. Shift+Enter straight after a picked `@file:` chip, or
  // as the first keystroke into an empty composer, produces exactly that shape
  // and is exactly what the user asked for; on every engine this branch used to
  // eat it.
  const last = editor.lastChild

  if (last?.nodeName === 'BR' && !isComposerBreak(last)) {
    let prev: ChildNode | null = last.previousSibling

    while (prev?.nodeType === Node.TEXT_NODE && !(prev.textContent || '').trim()) {
      prev = prev.previousSibling
    }

    if (!prev || (prev as HTMLElement).dataset?.refText) {
      editor.removeChild(last)
    }
  }
}
