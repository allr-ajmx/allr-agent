import { DATA_IMAGE_URL_RE, dataUrlToBlob } from '@/lib/embedded-images'
import { $reactionsEnabled } from '@/store/reactions-enabled'

export interface TriggerState {
  kind: ':' | '@' | '/'
  query: string
  tokenLength: number
}

// `@` triggers stop at the first whitespace — `@file:path` and `@diff` are
// single tokens. `/` triggers keep going so the popover stays live while the
// user types args (`/personality alic` → arg completer suggests `alice`).
// Restricting the slash command name to `[a-zA-Z][\w-]*` avoids matching file
// paths like `src/foo/bar`.
//
// Slash commands only execute at the beginning of a message, so the `/`
// trigger is anchored strictly at position 0 — not after whitespace — to
// avoid opening the popover mid-message (e.g. `hello /`).
const AT_TRIGGER_RE = /(?:^|[\s])(@)([^\s@/]*)$/
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

/** Caret-anchored text before the cursor, or null if the selection isn't a collapsed caret inside `editor`. */
export function textBeforeCaret(editor: HTMLDivElement): string | null {
  const sel = window.getSelection()
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null

  if (!range?.collapsed || !editor.contains(range.commonAncestorContainer)) {
    return null
  }

  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)

  return before.toString()
}

export function detectTrigger(textBefore: string): TriggerState | null {
  const slash = SLASH_TRIGGER_RE.exec(textBefore)

  if (slash) {
    return { kind: '/', query: slash[2], tokenLength: 1 + slash[2].length }
  }

  const at = AT_TRIGGER_RE.exec(textBefore)

  if (at) {
    return { kind: '@', query: at[2], tokenLength: 1 + at[2].length }
  }

  // After `@` so a directive starter's colon (`@file:`) stays an `@` query.
  // Rides the reactions opt-in (Settings → Appearance): the picker and the
  // completions are one "emoji features" surface, off by default together.
  const emoji = $reactionsEnabled.get() ? EMOJI_TRIGGER_RE.exec(textBefore) : null

  if (emoji) {
    return { kind: ':', query: emoji[2], tokenLength: 1 + emoji[2].length }
  }

  return null
}
