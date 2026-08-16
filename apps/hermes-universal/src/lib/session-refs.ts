/**
 * Pure helpers for `@session:<profile>/<id>` references.
 *
 * Deliberately free of React / store / gateway imports: the markdown
 * preprocessor runs on every streamed flush and must not drag the title
 * resolver (and through it the REST client) into that path. The stateful
 * lookup lives in `lib/session-link-title.ts`.
 *
 * Ported from desktop `lib/session-refs.ts`.
 */

/** Mirrors the composer/transcript form in `directive-text.ts`: a bare value,
 *  or one fenced in backticks/quotes so a value with spaces survives. The
 *  lookbehinds keep `foo@session:` and URL paths from matching, and skip a ref
 *  a model already wrapped in a markdown link — rewriting that would nest. */
export const SESSION_REF_RE = /(?<![\w/])(?<!]\()@session:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g

const TRAILING_PUNCTUATION_RE = /[,.;:!?)\]}]+$/

function unwrapQuotes(raw: string): null | string {
  if (raw.length < 2) {
    return null
  }

  const head = raw[0]
  const tail = raw[raw.length - 1]

  if ((head === '`' && tail === '`') || (head === '"' && tail === '"') || (head === "'" && tail === "'")) {
    return raw.slice(1, -1)
  }

  return null
}

/** Splits a matched value into the reference itself and any prose punctuation
 *  the greedy `\S+` branch swallowed. Quoted values are already fenced. */
export function splitSessionRefValue(raw: string): { trailing: string; value: string } {
  const quoted = unwrapQuotes(raw)

  if (quoted !== null) {
    return { trailing: '', value: quoted }
  }

  const value = raw.replace(TRAILING_PUNCTUATION_RE, '')

  return { trailing: raw.slice(value.length), value }
}

/**
 * Split a `@session:` ref VALUE into its profile and session id. The profile
 * half is optional: `@session:<id>` means "this profile".
 *
 * Session ids never contain a slash, so the FIRST slash is the separator —
 * the same `partition("/")` split `tools/session_search_tool.py` does when the
 * agent hands a whole link back as a `session_id`.
 */
export function parseSessionRefValue(value: string): { profile: null | string; sessionId: string } {
  const trimmed = value.trim()
  const slash = trimmed.indexOf('/')

  if (slash < 0) {
    return { profile: null, sessionId: trimmed }
  }

  const profile = trimmed.slice(0, slash).trim()
  const sessionId = trimmed.slice(slash + 1).trim()

  // `work/` names no session — treat the whole thing as an id rather than
  // resolving profile `work` against an empty one.
  return sessionId ? { profile: profile || null, sessionId } : { profile: null, sessionId: trimmed }
}

/** Cache key. The profile is part of it: the same id can exist in two profiles
 *  and mean two different conversations. */
export function sessionRefCacheKey(value: string): string {
  const { profile, sessionId } = parseSessionRefValue(value)

  return sessionId ? `${profile ?? ''}/${sessionId}` : ''
}

/** The label a chip shows while (or instead of) resolving — a truncated id. */
export function sessionRefFallbackLabel(value: string): string {
  const { sessionId } = parseSessionRefValue(value)

  if (!sessionId) {
    return value
  }

  return sessionId.length > 10 ? `${sessionId.slice(0, 8)}…` : sessionId
}

/** A fragment href — no custom URL scheme, so it survives markdown
 *  sanitization the same way `#media:` targets do. */
export function sessionMarkdownHref(value: string): string {
  return `#session/${encodeURIComponent(value)}`
}

export function sessionRefFromMarkdownHref(href?: string): null | string {
  if (!href?.startsWith('#session/')) {
    return null
  }

  try {
    return decodeURIComponent(href.slice('#session/'.length)) || null
  } catch {
    return null
  }
}

/**
 * Rewrite bare `@session:<profile>/<id>` tokens into markdown links so an
 * AGENT-authored reference reaches `MarkdownLink` and renders as a chip
 * instead of as literal text.
 *
 * The composer's own chips take the directive path (`DirectiveContent`), which
 * only ever runs on the user's own rows — an assistant turn is markdown, so
 * without this pass the one link the feature exists for never became a chip.
 *
 * Callers must exclude code spans / fences; `preprocessMarkdown` already does.
 */
export function linkifySessionRefs(text: string): string {
  if (!text.includes('@session:')) {
    return text
  }

  return text.replace(SESSION_REF_RE, (match, raw: string) => {
    const { trailing, value } = splitSessionRefValue(raw)

    if (!parseSessionRefValue(value).sessionId) {
      return match
    }

    const label = sessionRefFallbackLabel(value).replace(/[[\]\\]/g, '\\$&')

    return `[${label}](${sessionMarkdownHref(value)})${trailing}`
  })
}
