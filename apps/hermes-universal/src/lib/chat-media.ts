import { filePathFromMediaPath, isFileMediaPath, mediaDisplayLabel, mediaMarkdownHref } from '@/lib/media-format'

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
function rewriteMediaMarkers(text: string): string {
  return text
    .replace(
      MEDIA_LINE_RE,
      (_match, lead: string, value: string, trailer: string) => `${lead}${mediaLink(value)}${trailer}`
    )
    .replace(MEDIA_TAG_RE, (_match, value: string) => mediaLink(value))
}

/** A markdown link or image, with its target — `[label](target)`. */
const FILE_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?\s*\)/g

/** A trailing `.ext`, the cue that a bare `/…` target is a file and not a route. */
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]{1,12}$/

/**
 * The other way the agent points at a file: an ordinary markdown link to a
 * gateway path, `[report](/abs/report.pdf)` or `[report](file:///abs/report.pdf)`.
 *
 * Same destination as a `MEDIA:` marker, so it takes the same road. Left alone
 * both shapes are dead on arrival:
 *
 *  * streamdown sanitizes with hast-util-sanitize's GitHub schema, whose href
 *    protocol allowlist is http/https/irc/ircs/mailto/xmpp. A `file:` href has
 *    the attribute DELETED before React sees it, so `MarkdownLink` gets
 *    `href === undefined` and renders inert link text.
 *  * A bare path survives sanitize but falls through `MarkdownLink` to
 *    `openExternalLink`, which asks THIS device's OS to open a path that only
 *    exists on the gateway.
 *
 * A `#…` fragment is untouched by sanitize — the `#` precedes any `:`, so there
 * is no protocol to reject — which is why `#media:` and `#session/` already work.
 *
 * Images keep a bare path rather than a fragment: `MarkdownImage` resolves the
 * path itself over the authenticated bridge, so they only need `file://`
 * stripped — a path with no protocol gives sanitize nothing to reject.
 *
 * A bare `/…` target must carry a file extension. Without that test this would
 * also claim `[docs](/guide)`, which is a route, not a file.
 */
function rewriteFileLinks(text: string): string {
  return text.replace(FILE_LINK_RE, (match, bang: string, label: string, target: string) => {
    if (!isFileMediaPath(target)) {
      return match
    }

    const path = filePathFromMediaPath(target)

    if (!/^file:/i.test(target) && !HAS_EXTENSION_RE.test(path)) {
      return match
    }

    return bang ? `${bang}[${label}](${path})` : `[${label}](${mediaMarkdownHref(path)})`
  })
}

/**
 * Every way the agent can hand over a file, normalized to the one `#media:`
 * href the renderer understands.
 *
 * `MEDIA:/abs/path` and `[label](/abs/path)` mean the same thing, so they get
 * the same treatment rather than each having its own half-pipe. Idempotent, and
 * safe to run over text the ingest pass below has already been through.
 *
 * This is the RENDER-stage entry point (`preprocessMarkdown`), which is what
 * makes it retroactive: an old transcript is normalized as it is drawn, with no
 * re-ingest and nothing rewritten on the gateway. It deliberately omits the
 * blank-line normalization `renderMediaTags` does — at render that would reflow
 * prose that has nothing to do with media.
 */
export function renderFileRefs(text: string): string {
  return rewriteFileLinks(rewriteMediaMarkers(text))
}

/**
 * The INGEST-stage pass (streaming deltas, `final_response`, history restore).
 *
 * Kept separate from {@link renderFileRefs} because of the trailing whitespace
 * normalization: both call sites guard it on a literal `MEDIA:` precisely so it
 * cannot reflow plain prose, and that guard is load-bearing for the streamed
 * vs. settled text comparison in `applyCompletion`.
 */
export function renderMediaTags(text: string): string {
  return rewriteMediaMarkers(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}
