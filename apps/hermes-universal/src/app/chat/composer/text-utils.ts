import { DATA_IMAGE_URL_RE, dataUrlToBlob } from '@/lib/embedded-images'
import { $reactionsEnabled } from '@/store/reactions-enabled'

import { serializeTextBefore } from './rich-editor'

export interface TriggerState {
  kind: ':' | '@' | '/'
  query: string
  /** The `@kind:` prefix the user scoped the browse to, when there is one. */
  scope?: DirectiveScope
  tokenLength: number
  /** `query` minus the `scope:` prefix — the value actually being typed. */
  value: string
}

/** Directive kinds the `@` popover can scope a browse to. Mirrors the starter
 *  rows in use-at-completions and the gateway's `complete.path` prefixes. */
export const DIRECTIVE_SCOPES = ['file', 'folder', 'url', 'image', 'tool', 'git'] as const

export type DirectiveScope = (typeof DIRECTIVE_SCOPES)[number]

// Picking "attach a folder" types `@folder:` into the editor, and everything
// after it is the value being browsed. Parsing that prefix off the query is
// what lets the rest of the composer treat it as the BROWSE MODE it is rather
// than characters the user has to maintain by hand — Tab-descending has to
// carry it down, Backspace has to drop it whole, and a paste landing on it has
// to consume it.
const AT_SCOPE_RE = new RegExp(`^(${DIRECTIVE_SCOPES.join('|')}):(.*)$`)

// `@` triggers stop at the first whitespace — `@file:path` and `@diff` are
// single tokens, and a path is part of that token: `@./src/`, `@~/Desktop/`
// and `@file:src/foo` all have to keep the popover live while the user walks
// into subdirectories. Excluding `/` from the query class ended the token at
// the first separator, which is exactly the "can't browse into a folder" bug.
// `/` triggers keep going so the popover stays live while the user types args
// (`/personality alic` → arg completer suggests `alice`). Restricting the
// slash command name to `[a-zA-Z][\w-]*` avoids matching file paths like
// `src/foo/bar`.
//
// Slash commands only execute at the beginning of a message, so the `/`
// trigger is anchored strictly at position 0 — not after whitespace — to
// avoid opening the popover mid-message (e.g. `hello /`).
//
// `\uFFFC` is the object-replacement character a chip serializes to, so a
// trigger typed straight after a chip still detects.
const AT_TRIGGER_RE = /(?:^|[\s\uFFFC])(@)([^\s@\uFFFC]*)$/
const SLASH_TRIGGER_RE = /^(\/)((?:[a-zA-Z][\w-]*(?:\s+\S*)*)?)$/
// `:joy` — two characters minimum, so a bare `:` (or a `12:30`) never opens the
// popover. `\uFFFC` is the object-replacement character a chip serializes to,
// which is what lets `@file:x :jo` still trigger after a chip.
const EMOJI_TRIGGER_RE = /(?:^|[\s\uFFFC])(:)([a-zA-Z0-9_+-]{2,})$/

const INLINE_IMAGE_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/[^"']+)["']/gi
// Below this, an inline data URL is chrome rather than content — a spacer, a
// 1×1 tracker, or a blurhash placeholder. Real pasted artwork clears it easily.
const MIN_INLINE_IMAGE_BYTES = 4096

/** Stable key for paste dedupe — `items` and `files` often mirror the same image as different objects. */
export function blobDedupeKey(blob: Blob): string {
  if (blob instanceof File) {
    return `file:${blob.name}:${blob.size}:${blob.type}:${blob.lastModified}`
  }

  return `blob:${blob.size}:${blob.type}`
}

export function extractClipboardImageBlobs(clipboard: DataTransfer): Blob[] {
  const blobs: Blob[] = []
  const seen = new Set<string>()

  const push = (blob: Blob | null) => {
    if (!blob || blob.size === 0) {
      return
    }

    const key = blobDedupeKey(blob)

    if (seen.has(key)) {
      return
    }

    seen.add(key)
    blobs.push(blob)
  }

  if (clipboard.items?.length) {
    for (const item of clipboard.items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        push(item.getAsFile())
      }
    }
  }

  // Chromium/Electron expose the same pasted image on both `items` and `files`.
  if (blobs.length === 0 && clipboard.files?.length) {
    for (let i = 0; i < clipboard.files.length; i += 1) {
      const file = clipboard.files.item(i)

      if (file && file.type.startsWith('image/')) {
        push(file)
      }
    }
  }

  if (blobs.length > 0) {
    return blobs
  }

  const text = clipboard.getData('text/plain').trim()

  if (DATA_IMAGE_URL_RE.test(text)) {
    push(dataUrlToBlob(text))

    return blobs
  }

  // Inline `<img src="data:…">` in the clipboard's HTML — but only for a copy
  // that carried no text of its own. A rich-text copy WITH prose is a text
  // paste that happens to contain images, and its data URLs are the page's
  // decorations rather than content: Discord ships a 32×5 blurhash placeholder
  // beside every image embed, so copying a thread attached a blank thumbnail
  // and (because an image paste swallows the event) dropped the text entirely.
  if (!text) {
    for (const match of clipboard.getData('text/html').matchAll(INLINE_IMAGE_SRC_RE)) {
      const blob = dataUrlToBlob(match[1])

      if (blob && blob.size >= MIN_INLINE_IMAGE_BYTES) {
        push(blob)
      }
    }
  }

  return blobs
}

/** Caret-anchored text before the cursor, or null if the selection isn't a
 *  collapsed caret inside `editor`.
 *
 *  Serialized, not `Range.toString()`: the raw string leaks each chip's LABEL
 *  text into what the trigger regexes see, and a `/work` pill whose label
 *  serialized into this text made the `^`-anchored command regex treat
 *  everything after it as that command's argument — silencing the `@` popover
 *  for the rest of the message. Each chip contributes an object-replacement
 *  placeholder instead, and <br> a newline, so a trigger at the start of a
 *  wrapped line still detects. */
export function textBeforeCaret(editor: HTMLDivElement): string | null {
  const sel = window.getSelection()
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null

  if (!range?.collapsed || !editor.contains(range.commonAncestorContainer)) {
    return null
  }

  return serializeTextBefore(editor, range.startContainer, range.startOffset)
}

/** How many characters of directive scope the caret is sitting inside (`@url:`
 *  with nothing typed after it), or 0. A paste lands INTO that scope: the scope
 *  text is consumed rather than left in front of the chip as leftover syntax. */
export function openDirectiveScope(editor: HTMLDivElement): number {
  const trigger = detectTrigger(textBeforeCaret(editor) ?? '')

  return trigger?.kind === '@' && trigger.scope && !trigger.value ? trigger.tokenLength : 0
}

export function detectTrigger(textBefore: string): TriggerState | null {
  const slash = SLASH_TRIGGER_RE.exec(textBefore)

  if (slash) {
    return { kind: '/', query: slash[2], tokenLength: 1 + slash[2].length, value: slash[2] }
  }

  const at = AT_TRIGGER_RE.exec(textBefore)

  if (at) {
    const query = at[2]
    const scoped = AT_SCOPE_RE.exec(query)

    return {
      kind: '@',
      query,
      ...(scoped ? { scope: scoped[1] as DirectiveScope } : {}),
      tokenLength: 1 + query.length,
      value: scoped ? (scoped[2] ?? '') : query
    }
  }

  // After `@` so a directive starter's colon (`@file:`) stays an `@` query.
  // Rides the reactions opt-in (Settings → Appearance): the picker and the
  // completions are one "emoji features" surface, off by default together.
  const emoji = $reactionsEnabled.get() ? EMOJI_TRIGGER_RE.exec(textBefore) : null

  if (emoji) {
    return { kind: ':', query: emoji[2], tokenLength: 1 + emoji[2].length, value: emoji[2] }
  }

  return null
}
