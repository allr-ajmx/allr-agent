/**
 * What a user bubble knows about itself when it asks for a restore confirm.
 *
 * Deliberately NOT the user ordinal. The ordinal is a store-global count the
 * backend truncates by, and a bubble can only count the rendered thread — which
 * is a windowed tail (`app/chat/transcript-window.ts`). `thread.tsx` resolves it
 * from the session's own messages at click time instead.
 */
export interface RestoreMessageTarget {
  text: string
}
