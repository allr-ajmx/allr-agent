// Composer chip helpers, ported from the composer-facing half of
// apps/desktop/src/components/assistant-ui/directive-text.tsx. The React
// renderer for the same references inside SENT user messages lives next door in
// `directive-content.tsx` — the two halves are one file on desktop and split
// here only to avoid a `.ts`/`.tsx` basename clash on the import specifier.

import type { Unstable_DirectiveFormatter, Unstable_DirectiveSegment, Unstable_TriggerItem } from '@assistant-ui/core'

import { sessionRefFallbackLabel } from '@/lib/session-refs'

import { referenceKind, referenceRe, referenceStyle } from './reference-kinds'

/** Icon glyphs come from the shared reference vocabulary, so the popover row
 *  and the chip it becomes can never drift apart. */
export const iconPathsFor = (type: string) => referenceStyle(type).paths

/**
 * The class + attributes that make any element an inline reference. Pair with
 * the `.ref` rules in styles.css, which own the per-kind accent — pass the kind
 * and the theme decides the colour.
 *
 * One helper for every surface: the composer's contenteditable chips, a sent
 * message's mentions, a markdown link, a completion row's glyph. If it points
 * at something from inside text, it goes through here.
 */
export function refAttrs(kind?: string, extra?: string): { className: string; 'data-ref'?: string } {
  const className = extra ? `ref ${extra}` : 'ref'

  return kind ? { className, 'data-ref': referenceKind(kind) } : { className }
}

/** The same thing as a raw attribute string, for HTML built by hand. */
export function refAttrsHtml(kind?: string): string {
  return kind ? `class="ref" data-ref="${referenceKind(kind)}"` : 'class="ref"'
}

const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'

/** SVG markup string for embedding directly in HTML (composer contenteditable).
 *  Unclassed on purpose: size, spacing and opacity come from `.ref > svg`. */
export function directiveIconSvg(type: string) {
  const inner = iconPathsFor(type)
    .map(d => `<path d="${d}"/>`)
    .join('')

  return `<svg ${SVG_ATTRS}>${inner}</svg>`
}

function iconElementFromPaths(paths: string[]) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}

export function directiveIconElement(type: string) {
  return iconElementFromPaths(iconPathsFor(type))
}

/** Commands, skills, and themes are three more reference kinds — no separate
 *  pill styling, just the shared `.ref` treatment with their own accent. */
export type SlashChipKind = 'command' | 'skill' | 'theme'

export function slashIconElement(kind: SlashChipKind) {
  return iconElementFromPaths(iconPathsFor(kind))
}

/**
 * The label a reference wears, on every surface: the composer chip, the sent
 * message, the completion row that inserted it.
 *
 * Paths keep their directory for the reason links keep theirs: a bare basename
 * can't tell two references apart (`src`, `index.ts`, `main.tsx` repeat all
 * over a repo), and browsing into `apps/hermes-universal/` only to be handed a
 * chip reading `hermes-universal` throws away the context you navigated for.
 * Overflow is the caller's problem (`truncate` / `wrap-anywhere`).
 */
export function refChipLabel(type: string, id: string): string {
  if (type === 'terminal') {
    return id || 'terminal'
  }

  if (type === 'session') {
    return sessionRefFallbackLabel(id)
  }

  if (type === 'url') {
    try {
      const { hostname, pathname, search } = new URL(id)
      const path = `${pathname}${search}`.replace(/\/$/, '')

      return `${hostname.replace(/^www\./i, '')}${path}` || id
    } catch {
      return id
    }
  }

  // `./` is noise the completer emits, not part of the reference. A trailing
  // slash is kept — it's what distinguishes a folder from a file.
  return id.replace(/^\.\//, '') || id
}

function needsQuoting(value: string): boolean {
  return /[\s()[\]{}<>"'`]/.test(value)
}

export function formatRefValue(value: string): string {
  if (!needsQuoting(value)) {
    return value
  }

  if (!value.includes('`')) {
    return `\`${value}\``
  }

  if (!value.includes('"')) {
    return `"${value}"`
  }

  if (!value.includes("'")) {
    return `'${value}'`
  }

  return value
}

// ---------------------------------------------------------------------------
// Directive formatter for assistant-ui's composer trigger system (ported from
// desktop directive-text.tsx). The ported composer's use-composer-trigger calls
// `hermesDirectiveFormatter.serialize(item)` to turn a picked completion into
// its `@type:value` chip text. `parse` is provided for contract completeness.
// ---------------------------------------------------------------------------

const CANONICAL_DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/g

const HERMES_DIRECTIVE_RE = referenceRe()

// A skill referenced in a sent message — either the invocation that opens it
// (`/work fix the leak`, which is all a skill turn ever renders as) or one
// named mid-prose ("clean this up with /clean"). The composer inserts both as
// pills, so the sent message renders them as pills too rather than flattening
// back to raw text the moment the user hits Enter.
//
// Unlike the composer's caret-anchored trigger this scans finished text, so it
// must reject a token that continues into a path: `/usr/local/bin` would
// otherwise chip as `/usr`. `(?![\w-]*\/)` requires the token to end at
// something other than another slash.
const SLASH_SKILL_RE = /(?<=^|\s)\/([a-zA-Z][\w-]*)(?![\w-]*\/)/g

const TRAILING_PUNCTUATION_RE = /[,.;!?]+$/

function unwrapRefValue(raw: string): string {
  if (raw.length < 2) {
    return raw
  }

  const head = raw[0]
  const tail = raw[raw.length - 1]

  if ((head === '`' && tail === '`') || (head === '"' && tail === '"') || (head === "'" && tail === "'")) {
    return raw.slice(1, -1)
  }

  return raw.replace(TRAILING_PUNCTUATION_RE, '')
}

function parseDirectiveText(text: string): Unstable_DirectiveSegment[] {
  const matches = [
    ...Array.from(text.matchAll(CANONICAL_DIRECTIVE_RE)).map(match => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      type: match[1] || 'tool',
      label: match[2] || match[3] || '',
      id: match[3] || match[2] || ''
    })),
    ...Array.from(text.matchAll(HERMES_DIRECTIVE_RE)).map(match => {
      const id = unwrapRefValue(match[2] || '')

      return {
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        type: match[1] || 'file',
        label: refChipLabel(match[1] || 'file', id),
        id
      }
    }),
    ...Array.from(text.matchAll(SLASH_SKILL_RE)).map(match => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      type: 'skill',
      label: match[1] || '',
      id: `/${match[1]}`
    }))
  ]
    .filter(match => match.id)
    .sort((a, b) => a.start - b.start)

  const segments: Unstable_DirectiveSegment[] = []
  let cursor = 0

  for (const match of matches) {
    if (match.start < cursor) {
      continue
    }

    if (match.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.start) })
    }

    segments.push({ kind: 'mention', type: match.type, label: match.label, id: match.id })
    cursor = match.end
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }

  return segments
}

export const hermesDirectiveFormatter: Unstable_DirectiveFormatter = {
  serialize(item: Unstable_TriggerItem): string {
    const metadata = item.metadata as { rawText?: unknown; insertId?: unknown } | undefined
    const rawText = typeof metadata?.rawText === 'string' ? metadata.rawText : null
    const insertId = typeof metadata?.insertId === 'string' ? metadata.insertId : null

    if (rawText) {
      if (rawText.endsWith(':') && !insertId) {
        return rawText
      }

      if (!insertId) {
        return rawText
      }

      const kindMatch = rawText.match(/^@([^:]+):/)
      const kind = kindMatch?.[1] ?? item.type

      return `@${kind}:${formatRefValue(insertId)}`
    }

    if (item.id === `${item.type}:`) {
      return `@${item.id}`
    }

    return `@${item.type}:${formatRefValue(item.id)}`
  },
  parse(text: string): readonly Unstable_DirectiveSegment[] {
    return parseDirectiveText(text)
  }
}
