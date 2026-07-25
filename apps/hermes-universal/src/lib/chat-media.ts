import { mediaDisplayLabel, mediaMarkdownHref } from '@/lib/media-format'

// Rewrites the agent's `MEDIA:<path>` markers into markdown links whose href is
// the `#media:` scheme MarkdownLink → MediaAttachment renders inline. The gateway
// emits media as a bare `MEDIA:/abs/path` line (or inline tag); without this pass
// it shows as literal text. Ported from apps/desktop/src/lib/chat-messages.ts.

// A whole line that is just a MEDIA: marker (optionally quoted) — consumes the
// line so the surrounding blank lines stay tidy.
const MEDIA_LINE_RE = /(^|\n)[\t ]*[`"']?MEDIA:\s*(?<line>`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)[`"']?[\t ]*(\n|$)/g

// An inline MEDIA: tag anywhere in the text.
const MEDIA_TAG_RE = /[`"']?MEDIA:\s*(?<inline>`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)[`"']?/g

function unquoteMediaPath(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]

  return quote && quote === trimmed.at(-1) && ['"', "'", '`'].includes(quote) ? trimmed.slice(1, -1) : trimmed
}

function mediaLink(value: string): string {
  const path = unquoteMediaPath(value)

  return `[${mediaDisplayLabel(path)}](${mediaMarkdownHref(path)})`
}

/** Replace every `MEDIA:<path>` marker with a `#media:` markdown link. Idempotent
 *  (a text with no `MEDIA:` literal is returned unchanged). */
export function renderMediaTags(text: string): string {
  return text
    .replace(MEDIA_LINE_RE, (_match, lead: string, value: string, trailer: string) => `${lead}${mediaLink(value)}${trailer}`)
    .replace(MEDIA_TAG_RE, (_match, value: string) => mediaLink(value))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}
