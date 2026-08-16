import type { SessionView } from '@/app/chat/session-view'
import { chatMessageText, collectUnspokenTurnSpeech } from '@/lib/chat-messages'

// The shared "last spoken reply" cursor, dedupe between the voice-conversation
// loop and `useAutoSpeakReplies` so a reply is never read aloud twice. Keyed per
// SessionView (a WeakMap), so it is per-session — a tile's conversation reads that
// tile's replies, not the primary chat's (the pre-existing bug where
// `use-composer-voice` closed over the global `$messages`). Session switches on the
// primary view are handled by `useAutoSpeakReplies` re-marking on `sessionId`.

export interface VoiceReply {
  id: string
  pending: boolean
  text: string
}

const spokenByView = new WeakMap<SessionView, string>()

function latestAssistant(view: SessionView) {
  const messages = view.$messages.get()

  // reverse-find (not Array.findLast — universal's tsconfig targets es2021);
  // universal ChatMessage has no `hidden`, guarded via a widening cast.
  return [...messages].reverse().find(m => m.role === 'assistant' && !(m as { hidden?: boolean }).hidden)
}

/** The latest completed/streaming assistant reply not yet marked spoken, else null. */
export function lastReply(view: SessionView): VoiceReply | null {
  const last = latestAssistant(view)

  if (!last || last.id === spokenByView.get(view)) {
    return null
  }

  const text = chatMessageText(last).trim()

  if (!text) {
    return null
  }

  return { id: last.id, pending: Boolean(last.pending), text }
}

/**
 * The WHOLE unspoken turn — every assistant bubble since the cursor, joined —
 * not just the newest one.
 *
 * This is what the conversation loop narrates. `lastReply` above stays the
 * auto-speak selector: a read-aloud backlog deliberately collapses to the newest
 * reply, while a hands-free turn must be heard in full (narration interims AND
 * the final answer). See `collectUnspokenTurnSpeech`.
 */
export function unspokenTurn(view: SessionView): null | VoiceReply {
  return collectUnspokenTurnSpeech(view.$messages.get(), spokenByView.get(view) ?? null)
}

/** Mark the current last reply as spoken (dedupe cursor advance). */
export function markReplySpoken(view: SessionView): void {
  const last = latestAssistant(view)

  if (last) {
    spokenByView.set(view, last.id)
  }
}
