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

export type Role = 'assistant' | 'system' | 'user'

export interface TextPart {
  type: 'text'
  text: string
}
export interface ReasoningPart {
  type: 'reasoning'
  text: string
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

// Append a streaming delta into the tail part when it's the same channel, else
// open a new part.
export function appendStreamPart(parts: ChatPart[], type: 'reasoning' | 'text', delta: string): ChatPart[] {
  if (!delta) {
    return parts
  }

  // Coalesce into the most recent same-type part within the current segment
  // (bounded by non-streaming parts like tool calls). The opposite streaming
  // channel (text<->reasoning) is TRANSPARENT — so a reasoning burst between two
  // content deltas can't shred one sentence into text / Thinking / text.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]

    if (part.type === type) {
      const copy = parts.slice()
      copy[i] = { type, text: part.text + delta }

      return copy
    }

    if (part.type !== 'text' && part.type !== 'reasoning') {
      break
    }
  }

  return [...parts, { type, text: delta }]
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
export function applySettledReasoning(parts: ChatPart[], text: string): ChatPart[] {
  const settled = text.trim()

  if (!settled) {
    return parts
  }

  if (parts.some(part => part.type === 'reasoning' && part.text.trim().includes(settled))) {
    return parts
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]

    if (part.type === 'reasoning') {
      const copy = parts.slice()
      copy[i] = { type: 'reasoning', text }

      return copy
    }

    // Any prose or tool call closes the previous thinking block.
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

  const settle = (message: ChatMessage): ChatMessage =>
    error
      ? { ...message, error, parts: message.parts.filter(part => part.type !== 'text'), pending: false }
      : { ...message, parts: finalizeParts(message.parts, finalText), pending: false }

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
