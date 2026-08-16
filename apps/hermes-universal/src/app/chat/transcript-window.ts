import type { ChatMessage } from '@/lib/chat-messages'
import { messageStoreWeight } from '@/lib/render-weight'

/**
 * Bound what reaches assistant-ui at all.
 *
 * Rendering the full transcript of an oversized session rebuilds an unbounded
 * runtime repository on every store update and exhausts the renderer's V8 heap
 * (#55191). The DOM budget in `thread/list.tsx` already bounds what PAINTS, but
 * every message still gets normalized into the repository first — so a session
 * only has to be heavy, not visible, to crash the window.
 *
 * The window spends the same currency as the DOM budget: render weight, not
 * message count. A count cap gets this wrong in both directions — measured on a
 * real 1,175-session store, a 400-message cap would disable itself on 37
 * sessions that are heavy but short (one was 133 messages / 1.05MB) while
 * engaging on 92 long-but-light sessions that were never at risk.
 */

/**
 * One window page, in render-weight units.
 *
 * Two DOM pages (the `RENDER_BUDGET` of 600 in `thread/list.tsx`). "Show
 * earlier" spends the DOM budget first, so the user pages through the
 * already-materialized window before this asks the store for more — and a
 * transcript heavy enough to exhaust the heap is windowed rather than handed
 * to the repository whole.
 */
export const TRANSCRIPT_WINDOW_BUDGET = 1200

/**
 * Floor on messages kept regardless of weight. A transcript of enormous turns
 * must still render the turn the user is having; without this a single
 * multi-megabyte tool result could window everything after it away.
 */
export const TRANSCRIPT_WINDOW_MIN_MESSAGES = 30

export interface TranscriptWindow {
  /** The tail assistant-ui is allowed to materialize. */
  messages: ChatMessage[]
  /** Store holds older messages than this window. */
  windowed: boolean
}

/**
 * Select the tail of the transcript that fits one window, grown by `pages`.
 *
 * Walks newest-first accumulating weight until the budget is met, keeping at
 * least MIN messages. (Desktop additionally aligns the cut off a branch-group
 * boundary; universal's transcript has no branch groups to cut through.)
 */
export function selectTranscriptWindow(messages: readonly ChatMessage[], pages = 1): TranscriptWindow {
  const budget = TRANSCRIPT_WINDOW_BUDGET * Math.max(1, Math.floor(pages))

  if (messages.length === 0) {
    return { messages: messages as ChatMessage[], windowed: false }
  }

  let start = messages.length
  let weight = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    weight += messageStoreWeight(messages[i].parts)
    start = i

    if (weight >= budget && messages.length - i >= TRANSCRIPT_WINDOW_MIN_MESSAGES) {
      break
    }
  }

  if (start <= 0) {
    // Preserve reference identity when the whole transcript fits: handing React
    // a fresh array of the same messages re-renders the runtime for nothing.
    return { messages: messages as ChatMessage[], windowed: false }
  }

  return { messages: messages.slice(start), windowed: true }
}

/**
 * How far past the budget a window may grow before the cut moves again.
 * Half a page: each re-cut trims about this much, so streaming causes one
 * re-cut per ~half page of new content instead of one per flush.
 */
export const TRANSCRIPT_WINDOW_SLACK = TRANSCRIPT_WINDOW_BUDGET / 2

export interface TranscriptWindowState {
  /** Id of the window's first message; null while the transcript is uncut. */
  anchorId: null | string
  pages: number
  window: TranscriptWindow
}

/**
 * `selectTranscriptWindow` with a STICKY cut.
 *
 * A fresh weight-walk per store flush moves the cut forward as the streaming
 * tail grows — one message at a time, ~30x/s. Every slide re-indexes the whole
 * windowed transcript: each row of the thread now renders a DIFFERENT message
 * (full markdown re-parse + re-highlight per row, a fresh `resetKey` for every
 * error boundary) and assistant-ui's message repository takes its O(window)
 * rebuild path instead of the one-message update. That — not the transcript's
 * size — is the long-session collapse: below the budget the window is
 * pass-through and streaming is O(1); the flush the transcript outgrew it,
 * every token cost a whole-window re-render. A budget meant to protect long
 * sessions made them slower at exactly the length it engaged.
 *
 * So the cut is anchored to a message id and holds while the tail stays within
 * budget + slack. Streaming then costs a re-cut once per ~half page of content.
 * The anchor vanishing (session swap, compression rewrite) or a pages change
 * ("Show earlier") falls through to a fresh walk.
 *
 * Ported from desktop (upstream `920beecfa8`).
 */
export function advanceTranscriptWindow(
  prev: null | TranscriptWindowState,
  messages: readonly ChatMessage[],
  pages = 1
): TranscriptWindowState {
  const budget = TRANSCRIPT_WINDOW_BUDGET * Math.max(1, Math.floor(pages))

  if (prev && prev.pages === pages && messages.length > 0) {
    const start = prev.anchorId === null ? 0 : messages.findIndex(message => message.id === prev.anchorId)

    if (start !== -1) {
      let weight = 0

      for (let i = messages.length - 1; i >= start; i--) {
        weight += messageStoreWeight(messages[i].parts)
      }

      if (weight <= budget + TRANSCRIPT_WINDOW_SLACK) {
        // An anchored cut that has drifted back to index 0 means the messages
        // before it are GONE (a compaction rewrote the history), so there is
        // nothing earlier to page to and `windowed` is false — desktop reports
        // true here and offers a "Show earlier" that resolves to the same
        // transcript. Reference identity is preserved either way.
        const window: TranscriptWindow =
          start === 0
            ? { messages: messages as ChatMessage[], windowed: false }
            : { messages: messages.slice(start), windowed: true }

        return { anchorId: prev.anchorId, pages, window }
      }
    }
  }

  const window = selectTranscriptWindow(messages, pages)

  return { anchorId: window.windowed ? window.messages[0].id : null, pages, window }
}
