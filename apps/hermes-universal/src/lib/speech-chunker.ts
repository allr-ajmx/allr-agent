// Split a growing assistant reply into speakable chunks. Pure port of the logic
// that used to live inline in `use-voice-conversation.ts` (`takeSpeechChunk`), so
// the voice loop can speak stable sentences as the stream grows without waiting
// for the whole reply. Extracted here to be unit-testable and reusable.
//
// A chunk is the unit `sanitizeTextForSpeech` (lib/speech-text.ts) is applied to
// at the playback seam, so this file has one obligation beyond "cut on sentence
// boundaries": NEVER hand the sanitizer half a markdown block. Its table, list,
// heading and thematic-break rules are line-structured, and its fenced-code rule
// needs both fences, so a chunk that was flattened to one line — or cut through
// the middle of a fence — is one the sanitizer cannot clean, and the markup gets
// voiced. That is why line breaks are preserved here (the sanitizer collapses
// them itself, so nothing reaches the engine with a newline in it) and why an
// unterminated fence is held back rather than cut.

export interface SpeechChunk {
  /** A speakable chunk, or null if the buffer has no stable boundary yet. */
  chunk: string | null
  /** What remains in the buffer after taking `chunk`. */
  rest: string
}

/**
 * Take the next speakable chunk from `rawBuffer`.
 *
 * A BLANK LINE is a hard boundary, handled before everything else. It is what
 * `collectUnspokenTurnSpeech` joins a turn's sealed bubbles on: the text before
 * it is finished — nothing will ever be appended to it — so it is flushed even
 * without terminal punctuation instead of being held until the next bubble
 * happens to produce a full stop. Splitting first also keeps the boundary out of
 * the whitespace-collapsing rules below, which would otherwise fold two bubbles
 * into one run-on sentence AND destroy every later boundary in `rest`.
 *
 * An UNTERMINATED fenced code block is held back whole (nothing after its
 * opening ``` is offered until the closing fence arrives or `force` ends the
 * turn). Cutting into one — which a blank line inside the fence, or the long-
 * buffer split below, would otherwise do — leaves the opening fence in the first
 * chunk and bare source in the ones after it, and the sanitizer summarises only
 * the piece that still carries a fence. The rest gets read out as code.
 *
 * Within one paragraph:
 * - A leading sentence (ending `.!?。！？`) is taken once it is at least 8 chars,
 *   or immediately when `force`. The sentence must lie on ONE line: a line break
 *   inside a paragraph is where a list, table or fence starts, and taking a
 *   "sentence" across it is what splits those blocks apart.
 * - Otherwise, when not forcing and the buffer is long (>220) AND is a single
 *   running line, it is split at the last soft boundary (`, ` / `; ` / `: `)
 *   before index 180 (past index 80). Multi-line buffers are exempt: their
 *   commas are as likely to be inside a table row or an argument list as in
 *   prose.
 * - When `force`, whatever remains is flushed as one final chunk.
 * - Otherwise nothing is taken yet.
 */
export function takeSpeechChunk(rawBuffer: string, force = false): SpeechChunk {
  const fences = fencedSpans(rawBuffer)
  const unterminated = fences.at(-1)

  if (!force && unterminated && !unterminated.closed) {
    const held = rawBuffer.slice(unterminated.start)
    const { chunk, rest } = takeSpeechChunk(rawBuffer.slice(0, unterminated.start), false)

    return { chunk, rest: rest ? `${rest}\n${held}` : held }
  }

  const sealed = sealedParagraph(rawBuffer, fences)

  if (sealed) {
    // `force` on the sealed head, not the caller's: the paragraph is complete
    // regardless of whether the turn as a whole is.
    const { chunk, rest } = takeFromParagraph(sealed.head, true)

    return { chunk, rest: rest ? `${rest}\n\n${sealed.tail}` : sealed.tail }
  }

  return takeFromParagraph(rawBuffer, force)
}

interface FencedSpan {
  start: number
  end: number
  closed: boolean
}

/**
 * The fenced-code spans of `buffer`, an unterminated one running to the end.
 *
 * Plain ``` occurrences, deliberately matching what `FENCED_CODE_RE` in
 * lib/speech-text.ts pairs up — the two have to agree on what a fence is, or the
 * hold-back protects a different span than the sanitizer summarises.
 */
function fencedSpans(buffer: string): FencedSpan[] {
  const fence = /```/g
  const spans: FencedSpan[] = []
  let match: null | RegExpExecArray

  while ((match = fence.exec(buffer))) {
    const last = spans.at(-1)

    if (last && !last.closed) {
      last.end = match.index + match[0].length
      last.closed = true
    } else {
      spans.push({ start: match.index, end: buffer.length, closed: false })
    }
  }

  return spans
}

/**
 * Split at the first blank line — the hard boundary `collectUnspokenTurnSpeech`
 * joins a turn's sealed bubbles on — that is NOT inside a fenced block.
 *
 * The fence check is the whole reason this isn't one regex: a blank line inside
 * a code fence is not a paragraph break, and sealing on it cuts the block in
 * two. The head then still carries the opening ``` and is summarised, while the
 * tail is bare source with no fence left on it — and gets read out as code.
 */
function sealedParagraph(buffer: string, fences: FencedSpan[]): null | { head: string; tail: string } {
  const blankLine = /[ \t]*\n[ \t]*\n/g
  let match: null | RegExpExecArray

  while ((match = blankLine.exec(buffer))) {
    const { 0: text, index } = match

    if (fences.some(span => index > span.start && index < span.end)) {
      continue
    }

    const head = buffer.slice(0, index)

    if (head.trim()) {
      return { head, tail: buffer.slice(index + text.length) }
    }
  }

  return null
}

/** A line that is nothing but a list marker — mirrors `LIST_MARKER_RE` in
 *  lib/speech-text.ts, which is what strips it once the item is attached. */
const LIST_MARKER_ONLY_RE = /^(?:[-+*]|\d{1,3}[.)])$/

/** Drop leading whitespace only. A `rest` keeps its TRAILING space: the caller
 *  appends the next streaming delta straight onto it, and a delta boundary that
 *  happens to land after a space would otherwise run two words together
 *  ("2. second" → "2.second", which then hides the list marker from the
 *  sanitizer, and in prose is simply the wrong word). */
function trimLead(text: string): string {
  return text.replace(/^\s+/, '')
}

function takeFromParagraph(rawBuffer: string, force: boolean): SpeechChunk {
  // Collapse runs of spaces/tabs, KEEP line breaks — see the note at the top of
  // the file. `sanitizeTextForSpeech` collapses them at the playback seam.
  const buffer = trimLead(rawBuffer.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n'))

  if (!buffer.trim()) {
    return { chunk: null, rest: '' }
  }

  const sentence = buffer.match(/^(.+?[.!?。！？])(?:\s+|$)/)

  // `force` waives the 8-char minimum, which let an ordered-list marker through
  // as a "sentence": "1." ends in a full stop followed by a space. That cut the
  // marker off from its item, and a marker with nothing after it is no longer a
  // marker to the sanitizer — so the list was voiced as "one. first item".
  if (sentence?.[1] && !LIST_MARKER_ONLY_RE.test(sentence[1]) && (sentence[1].length >= 8 || force)) {
    return { chunk: sentence[1].trim(), rest: trimLead(buffer.slice(sentence[1].length)) }
  }

  if (!force && !buffer.includes('\n') && buffer.length > 220) {
    const softBoundary = Math.max(
      buffer.lastIndexOf(', ', 180),
      buffer.lastIndexOf('; ', 180),
      buffer.lastIndexOf(': ', 180)
    )

    if (softBoundary > 80) {
      return { chunk: buffer.slice(0, softBoundary + 1).trim(), rest: trimLead(buffer.slice(softBoundary + 1)) }
    }
  }

  if (!force) {
    return { chunk: null, rest: buffer }
  }

  return { chunk: buffer.trim(), rest: '' }
}
