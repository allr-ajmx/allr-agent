/**
 * The one gate every DESTRUCTIVE close asks before it acts.
 *
 * Closing is the app's most divergent verb: a session tile, a mobile bubble and
 * a file tab are each closed by half a dozen triggers (a menu row, ⌘W,
 * ⌘-click, middle-click, a drag-up, a composer pill, a bulk "close others"),
 * and every one of them used to decide FOR ITSELF whether the thing being
 * closed was still holding work. The answers disagreed:
 *
 *  - a busy session TILE prompted, but the same session in a mobile BUBBLE was
 *    dropped mid-turn without a word — and the prompt's dialog was mounted
 *    inside `ContribController`, a component the phone never renders, so the
 *    warning could not have reached touch even if it had been asked for;
 *  - a file tab with unsaved edits closed silently through every one of its
 *    doors, clearing the dirty flag on the way out.
 *
 * So the decision moves here. A caller says WHAT it is closing and whether that
 * target is still holding something; the gate either runs the close at once or
 * parks it until the user answers.
 *
 * A QUEUE, not a single slot. "Close others" over three working chats used to
 * overwrite the pending id twice and prompt once — the other two silently
 * survived a verb the user had already confirmed, with nothing on screen to say
 * so. Each target now gets its own answer.
 */

import { atom, computed } from '@/store/atom'

/** Which copy the dialog shows, and what the caller is claiming is at stake. */
export type CloseConfirmKind = 'file' | 'session'

export interface PendingClose {
  /** The close to run if the user confirms. A thunk, so the gate never has to
   *  know how any of these surfaces close. */
  close: () => void
  /** Target identity (session id / file path) — de-dupes a target that one
   *  bulk verb named twice, and is what the dialog resolves its label from.
   *  The LABEL is deliberately not stored here: naming a session means reading
   *  `store/session-lookup`, which `store/session` itself can only reach
   *  through a dynamic import, so the lookup belongs on the React side. */
  id: string
  kind: CloseConfirmKind
  /** Identity of this PROMPT, handed back on resolve. The dialog answers with
   *  it rather than "the head", because `ConfirmDialog` calls `onClose` after a
   *  successful `onConfirm` — the same click would otherwise pop the queue
   *  twice and silently close the next tab without asking. */
  token: number
}

let nextToken = 0

const $queue = atom<PendingClose[]>([])

/** The close awaiting an answer, or null. The dialog reads only the head. */
export const $pendingClose = computed($queue, queue => queue[0] ?? null)

/**
 * Run `close()` — now if `needsConfirm` is false, otherwise once the user says so.
 *
 * The predicate is the CALLER's: only the session layer knows what "still
 * working" means and only the editor knows what "unsaved" means. What the gate
 * owns is that the question is asked once, in one place, through one dialog.
 */
export function requestClose(pending: Omit<PendingClose, 'token'>, needsConfirm: boolean): void {
  if (!needsConfirm) {
    pending.close()

    return
  }

  const queue = $queue.get()

  // A bulk verb can name the same target twice; one prompt per target.
  if (queue.some(entry => entry.kind === pending.kind && entry.id === pending.id)) {
    return
  }

  nextToken += 1
  $queue.set([...queue, { ...pending, token: nextToken }])
}

/** Answer one queued prompt. `confirmed` runs its close; either way the next
 *  pending close (if any) takes the dialog. A stale token is ignored. */
export function resolvePendingClose(token: number, confirmed: boolean): void {
  const queue = $queue.get()
  const head = queue[0]

  if (!head || head.token !== token) {
    return
  }

  $queue.set(queue.slice(1))

  if (confirmed) {
    head.close()
  }
}
