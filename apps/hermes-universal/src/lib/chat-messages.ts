// THE chat transcript model + its pure reducers — a LEAF module.
//
// Universal keeps ONE message type across the app: the `{ role, parts }`
// ChatMessage over the assistant-ui parts vocabulary (text / reasoning /
// tool-call), so converting to assistant-ui messages in app/chat/runtime.tsx is
// trivial.
//
// These helpers used to live in `store/chat.ts`, which made them unreachable
// from anything `store/chat.ts` itself imports. The unified session reducer
// (store/session-reducer.ts) applies exactly this logic to EVERY session's
// slice, so it has to be importable from a module with no store dependencies.
// Everything here is pure and side-effect free; `store/chat.ts` re-exports the
// whole surface so existing import sites keep working.
//
// Ported from apps/desktop/src/lib/chat-messages.ts.

import { renderMediaTags } from '@/lib/chat-media'
import { dedupeGeneratedImageEchoesInParts } from '@/lib/generated-images'
import type { MessageReaction } from '@/types/hermes'

export type Role = 'assistant' | 'system' | 'user'

export interface TextPart {
  type: 'text'
  text: string
}
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /**
   * This block is CLOSED: it is one complete, attributed thought and nothing
   * may be appended to it or written over it.
   *
   * Every other reasoning writer here walks backwards to the nearest reasoning
   * part and either concatenates onto it (`appendStreamPart`) or swaps it out
   * for the authoritative full text (`applySettledReasoning`) — the right rule
   * for one model's own scratchpad, which arrives as tokens and then as a
   * settled burst of the SAME thought.
   *
   * A MoA advisory block is not that. `moa.reference` carries a DIFFERENT
   * model's finished answer under its own `◇ Reference k/n — label` header, and
   * the aggregator's reasoning follows it immediately on the same session. With
   * no seal, the aggregator's first reasoning token was concatenated onto the
   * last advisor's body (misattributing it) and its settled burst replaced that
   * body outright (deleting an advisor answer the user paid for).
   */
  sealed?: boolean
}
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
}
export type ChatPart = ReasoningPart | TextPart | ToolCallPart

export interface ChatMessage {
  id: string
  role: Role
  parts: ChatPart[]
  /** Assistant message is still streaming. */
  pending?: boolean
  /** Sealed mid-turn commentary (`message.interim`) — rendered without the
   *  action-bar footer, so a turn that narrates itself across several
   *  paragraphs doesn't grow a copy/read-aloud row under each one. */
  interim?: boolean
  /**
   * The DURABLE `messages.id` this row was persisted as.
   *
   * The ids above are ephemeral and deliberately so — a live row, the same row
   * rehydrated from history, and an optimistic one are all shaped differently,
   * and a resume regenerates them. Anything that has to address one specific
   * persisted message later (reactions) needs this instead. Absent until the
   * row has round-tripped.
   */
  rowId?: number
  /** Emoji tapbacks persisted against this row, one per author. */
  reactions?: MessageReaction[]
  error?: string
}

let messageCounter = 0
export const nextId = (): string => `m${++messageCounter}-${Date.now()}`

/** The plain-text of a message: all text parts concatenated (reasoning/tool parts dropped). */
export function chatMessageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.text)
    .join('')
}

/**
 * Which user turn a message is, counted over the WHOLE transcript.
 *
 * The backend truncates a rewind by user ordinal, so the number has to be
 * counted against the session's own message list — never against what the
 * transcript happens to be rendering. assistant-ui is fed a WINDOWED tail
 * (`app/chat/transcript-window.ts`), so an ordinal derived from the rendered
 * thread is short by every user turn the window dropped, and handing that to
 * `truncate_before_user_ordinal` rewinds the session to a turn the user never
 * pointed at. Returns null when the id names no user turn.
 */
export function userTurnOrdinal(messages: readonly ChatMessage[], messageId: string): null | number {
  let ordinal = 0

  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }

    if (message.id === messageId) {
      return ordinal
    }

    ordinal += 1
  }

  return null
}

export interface UnspokenTurnSpeech {
  /** First unspoken assistant bubble — stable for the turn, the live speech session binds to it. */
  id: string
  /** Whether the newest assistant bubble is still streaming. */
  pending: boolean
  /** All unspoken assistant text in message order, bubbles joined on a blank line. */
  text: string
}

/**
 * Collect every unspoken assistant bubble after `lastSpokenId`, in order.
 *
 * A turn with tool calls produces several assistant bubbles — narration
 * ("Let me check…") sealed as interims, then the final answer as a fresh
 * bubble. The voice conversation speaks a turn through ONE growing string bound
 * to one response id, so selecting only the newest bubble silently drops
 * everything before it: a turn that narrated itself was heard as its last
 * sentence only. The blank-line join is a sentence boundary for the chunker
 * (lib/speech-chunker.ts), so a sealed bubble's tail is flushed as soon as the
 * next bubble starts rather than waiting for the whole turn.
 *
 * The result is APPEND-ONLY across a turn: `id` pins to the first unspoken
 * bubble and `text` only ever grows, which is what lets the controller feed the
 * delta by `slice(sourceLength)`.
 *
 * Ported from apps/desktop/src/lib/chat-messages.ts (upstream 9859e1f7df).
 */
export function collectUnspokenTurnSpeech(
  messages: ChatMessage[],
  lastSpokenId: null | string
): null | UnspokenTurnSpeech {
  // `findLastIndex` is ES2023 and this project's lib target predates it; scan back.
  let spokenIndex = -1

  if (lastSpokenId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id === lastSpokenId) {
        spokenIndex = i

        break
      }
    }
  }

  let id: null | string = null
  let pending = false
  const parts: string[] = []

  for (const message of messages.slice(spokenIndex + 1)) {
    // Universal's ChatMessage has no `hidden` field (desktop's does); the
    // widening cast keeps the port honest if one is ever added.
    if (message.role !== 'assistant' || (message as { hidden?: boolean }).hidden) {
      continue
    }

    // Read from the NEWEST assistant bubble, text or not — an empty bubble that
    // has only just opened is still "the turn is streaming".
    pending = Boolean(message.pending)
    const text = chatMessageText(message).trim()

    if (!text) {
      continue
    }

    id ??= message.id
    parts.push(text)
  }

  if (!id) {
    return null
  }

  return { id, pending, text: parts.join('\n\n') }
}

export function coerceText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(coerceText).join('')
  }

  return ''
}

/** A payload's string list (clarify / approval `choices`), or null when absent. */
export function coerceStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  return value.filter((item): item is string => typeof item === 'string')
}

export function newAssistant(): ChatMessage {
  return { id: nextId(), role: 'assistant', parts: [], pending: true }
}

export function withActiveAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1]

  if (last && last.role === 'assistant' && last.pending) {
    return messages
  }

  return [...messages, newAssistant()]
}

export function patchActive(messages: ChatMessage[], patch: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const next = withActiveAssistant(messages)
  const index = next.length - 1
  const copy = next.slice()
  copy[index] = patch(next[index])

  return copy
}

/**
 * Which part a streaming delta of `type` belongs to, or -1 for "open a new one".
 *
 * Coalesce into the most recent same-type part within the current segment
 * (bounded by non-streaming parts like tool calls). The opposite streaming
 * channel (text<->reasoning) is TRANSPARENT — so a reasoning burst between two
 * content deltas can't shred one sentence into text / Thinking / text.
 *
 * A SEALED reasoning part closes the reasoning segment: it is somebody else's
 * finished thought, so the next reasoning delta opens its own block rather than
 * continuing it. Text is unaffected — a sealed advisory sitting between two
 * prose deltas must still not split the sentence.
 */
function streamTargetIndex(parts: ChatPart[], type: 'reasoning' | 'text'): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]

    if (part.type === type) {
      return part.type === 'reasoning' && part.sealed ? -1 : i
    }

    if (part.type !== 'text' && part.type !== 'reasoning') {
      break
    }
  }

  return -1
}

// Append a streaming delta into the tail part when it's the same channel, else
// open a new part.
export function appendStreamPart(parts: ChatPart[], type: 'reasoning' | 'text', delta: string): ChatPart[] {
  if (!delta) {
    return parts
  }

  const index = streamTargetIndex(parts, type)

  if (index === -1) {
    return [...parts, { type, text: delta }]
  }

  const copy = parts.slice()
  copy[index] = { type, text: (parts[index] as ReasoningPart | TextPart).text + delta }

  return copy
}

/**
 * Append a reasoning delta and CLOSE the block it landed in.
 *
 * For chrome the model does not own — the `◇ MoA aggregating…` marker — where
 * the line has to survive whatever the aggregator says next. Without the seal
 * the marker is either swallowed by the aggregator's settled reasoning or, when
 * it lands after the advisory blocks (the order `agent/moa_loop.py` actually
 * emits in), glued onto the end of the last advisor's answer.
 */
export function appendSealedReasoning(parts: ChatPart[], delta: string): ChatPart[] {
  if (!delta) {
    return parts
  }

  const index = streamTargetIndex(parts, 'reasoning')

  if (index === -1) {
    return [...parts, { type: 'reasoning', text: delta, sealed: true }]
  }

  const copy = parts.slice()
  copy[index] = { type: 'reasoning', text: (parts[index] as ReasoningPart).text + delta, sealed: true }

  return copy
}

// Append an assistant text delta, then rewrite MEDIA: markers in the active text
// part to #media: links so media renders inline as it streams. Idempotent on
// already-rendered text — the guard skips parts with no MEDIA: literal.
export function appendAssistantTextPart(parts: ChatPart[], delta: string): ChatPart[] {
  const next = appendStreamPart(parts, 'text', delta)

  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i]

    if (part.type === 'text') {
      if (part.text.includes('MEDIA:')) {
        const rendered = renderMediaTags(part.text)

        if (rendered !== part.text) {
          const copy = next.slice()
          copy[i] = { type: 'text', text: rendered }

          return copy
        }
      }

      return next
    }

    // Stay within the current streaming segment (bounded by tool calls etc.).
    if (part.type !== 'reasoning') {
      break
    }
  }

  return next
}

// A settled reasoning burst (`reasoning.available` / `moa.reference`): the FULL
// text of one model step's scratchpad, capped at 500 chars by the gateway
// (agent/conversation_loop.py). A multi-step turn emits one per step, so this
// must never overwrite an earlier step's thinking block — the bug that left only
// the last blocks visible.
//
// Three cases, in order:
//  1. Already streamed via reasoning.delta (the burst is that text, or a capped
//     prefix of it) → drop it, it would be a duplicate "Thinking" block. This is
//     what desktop approximates with its "message already has text → skip" rule.
//  2. The live reasoning block is still open (nothing but reasoning since) →
//     swap in the authoritative full text.
//  3. Prose or a tool call already followed → open a NEW block, preserving the
//     chronology of the turn instead of clobbering the previous step.
//
// A SEALED block is case 3 as well, and for the same reason: it belongs to a
// step that is over. The aggregator's settled reasoning arriving after a MoA
// fan-out used to take case 2 and overwrite the LAST advisor's answer with it.
// The dedupe in case 1 skips sealed blocks too — it asks "did we already stream
// this very thought?", and another model's answer that happens to contain the
// same words is not that thought.
export function applySettledReasoning(parts: ChatPart[], text: string): ChatPart[] {
  const settled = text.trim()

  if (!settled) {
    return parts
  }

  if (parts.some(part => part.type === 'reasoning' && !part.sealed && part.text.trim().includes(settled))) {
    return parts
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]

    if (part.type === 'reasoning' && !part.sealed) {
      const copy = parts.slice()
      copy[i] = { type: 'reasoning', text }

      return copy
    }

    // Any prose, tool call or closed block ends the previous thinking block.
    break
  }

  return [...parts, { type: 'reasoning', text }]
}

// Gateway/provider failures sometimes arrive as `message.complete` text instead
// of an `error` event. Treat matches as inline assistant errors (desktop
// use-message-stream/utils.ts `completionErrorText`).
const COMPLETION_ERROR_PATTERNS = [
  /^API call failed after \d+ retries:/i,
  /^HTTP\s+\d{3}\b/i,
  /^(Provider|Gateway)\s+error:/i
]

export function completionErrorText(finalText: string): null | string {
  return finalText && COMPLETION_ERROR_PATTERNS.some(re => re.test(finalText)) ? finalText : null
}

const normalizeForCompare = (value: string): string => value.replace(/\s+/g, ' ').trim()

/**
 * Settle a turn's parts against the authoritative `final_response` the gateway
 * ships on `message.complete` (tui_gateway/server.py).
 *
 * The reply does NOT always arrive as `message.delta`: providers that only
 * stream their reasoning channel deliver the answer whole at the end, so the
 * live transcript showed the response inside a "Thinking" disclosure and no
 * prose at all — correct only after a reload, which re-reads the stored
 * transcript. Desktop settles this in `completeAssistantMessage`; universal
 * never applied the final text.
 *
 * Divergence from desktop, both deliberate: desktop replaces *every* text part
 * with one final part appended at the end, which reorders tool-interleaved
 * prose and drops it entirely when the completion carries no text (an
 * interrupted turn's partial). Here the final text only lands where it can't
 * lose anything — no text part yet, or exactly one to overwrite in place.
 */
export function finalizeParts(parts: ChatPart[], finalText: string): ChatPart[] {
  const reference = normalizeForCompare(finalText)

  // Drop a thinking block that IS the answer (the streamed-as-reasoning case).
  // Prefix either way: the reasoning channel may carry a capped prefix, or the
  // full text the gateway then repeats verbatim.
  const kept = parts.filter(part => {
    if (part.type !== 'reasoning') {
      return true
    }

    const text = normalizeForCompare(part.text)

    return !(text && (reference.startsWith(text) || text.startsWith(reference)))
  })

  const textIndexes = kept.reduce<number[]>((acc, part, index) => (part.type === 'text' ? [...acc, index] : acc), [])

  if (textIndexes.length === 0) {
    return [...kept, { type: 'text', text: finalText }]
  }

  // One text part = one streamed answer: overwrite in place so the final text
  // completes a truncated stream without moving it past the tool rows.
  if (textIndexes.length === 1) {
    const copy = kept.slice()
    copy[textIndexes[0]] = { type: 'text', text: finalText }

    return copy
  }

  // Tool-interleaved prose: the completion text maps to one of several parts and
  // we can't tell which, so leave the streamed transcript alone.
  return kept
}

export function applyCompletion(messages: ChatMessage[], text: string): ChatMessage[] {
  // The gateway's `final_response` carries the agent's raw `MEDIA:` markers,
  // while the streamed text has already been rewritten to `#media:` links. Left
  // raw, the completion overwrote a rendered attachment with literal
  // "MEDIA:/path" text at the end of every turn — the media appeared, then
  // vanished on settle — and the same-turn comparison below (rendered vs raw)
  // missed, appending a duplicate bubble. Guarded like the streaming call site:
  // the rewrite also normalizes blank lines, which must not touch plain prose.
  const finalText = text.includes('MEDIA:') ? renderMediaTags(text) : text
  const error = completionErrorText(finalText)

  // The authoritative final text is the model's own prose, restated generated
  // image and all — so the de-dupe has to run AFTER it lands, or the settle at
  // end of turn puts back the second copy the live pass removed.
  const settle = (message: ChatMessage): ChatMessage =>
    error
      ? { ...message, error, parts: message.parts.filter(part => part.type !== 'text'), pending: false }
      : {
          ...message,
          parts: dedupeGeneratedImageEchoesInParts(finalizeParts(message.parts, finalText)),
          pending: false
        }

  // An empty completion carries no authority (an interrupted turn reports no
  // final response) — settle whatever streamed instead of erasing it.
  if (!finalText) {
    return messages.map(message => (message.pending ? { ...message, pending: false } : message))
  }

  let index = -1

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      index = i

      break
    }
  }

  const existing = index === -1 ? null : messages[index]

  // A settled assistant that already says exactly this is the same turn arriving
  // twice (a trailing completion); anything else is a new reply with no bubble.
  if (existing && (existing.pending || chatMessageText(existing).trim() === finalText)) {
    return messages.map((message, i) => (i === index ? settle(message) : message))
  }

  return [...messages, settle(newAssistant())]
}
