/**
 * ONE vocabulary for reconciling a streaming transcript against arriving
 * history.
 *
 * Three sources describe the same turn and disagree about it:
 *
 *  - the LOCAL slice, which is the only place the turn's reasoning and tool
 *    calls exist while it runs;
 *  - the gateway's `inflight` snapshot, which is a flat pair of strings and
 *    cannot express any of that;
 *  - committed history, which only exists once the turn has finished.
 *
 * Every bug this module prevents comes from picking the wrong one: a text-only
 * snapshot overwriting structured rows, a flat dump sandwiched between them, an
 * optimistic user turn rendered a second time because the persisted copy came
 * back with its `@file:` line rewritten, a finished reply rendered twice
 * because history caught up mid-turn.
 *
 * These are protocol-shape problems, not renderer problems, which is why they
 * live in a leaf module the reducers and the hydration path both read rather
 * than being re-derived at each call site.
 */

import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import { embeddedImageUrls, textWithoutEmbeddedImages } from '@/lib/embedded-images'

/**
 * A row carrying content the gateway's flat snapshot CANNOT express.
 *
 * This is the pivot for every carry rule below: if the local row has structure
 * and the incoming one does not, the incoming one is a lossy description of the
 * same turn, not a newer version of it.
 */
export const hasStructuralParts = (message: ChatMessage): boolean =>
  message.parts.some(part => part.type === 'reasoning' || part.type === 'tool-call')

/**
 * A row belonging to the turn still in flight, by either of the two things that
 * mark one: the pending flag, or a projected/streamed id.
 *
 * `user-queued-` counts (MJXHRM-358). It is a projection of gateway-side state
 * exactly like `user-inflight-`, and the reconnect fold rebuilds the tail by
 * stripping these rows and re-projecting them: a queued prompt left in the
 * "committed" prefix was re-projected ON TOP of itself, so the same bubble
 * rendered twice under one React key — and it rendered ABOVE the assistant row
 * the projection appends after it, which is the wrong turn order.
 */
export const isLiveTailRow = (message: ChatMessage): boolean =>
  message.pending === true ||
  message.id.startsWith('assistant-stream-') ||
  message.id.startsWith('inflight-assistant-') ||
  message.id.startsWith('user-inflight-') ||
  message.id.startsWith('user-queued-')

/** Reference kinds that ride INSIDE the sent text as `@kind:value`. */
const WIRE_REFERENCE_KINDS = ['file', 'folder', 'url', 'image', 'tool', 'line', 'terminal', 'session'] as const

const REFERENCE_LINE_RE = new RegExp(`^@(?:${WIRE_REFERENCE_KINDS.join('|')}):\\S.*$`)

/**
 * Text with whole reference LINES removed.
 *
 * The gateway rewrites references on the way through — an absolute path
 * normalized, an image's inline data URL replaced by a path — so comparing raw
 * text makes the round-tripped copy of a message look like a different message,
 * and the optimistic row renders again beside it. Comparing the prose alone is
 * what makes "same message" survive the trip.
 *
 * Deliberately whole lines: an `@file:` the user typed mid-sentence is part of
 * what they wrote and must still count.
 */
export const textWithoutReferenceLines = (text: string): string =>
  text
    .split('\n')
    .filter(line => !REFERENCE_LINE_RE.test(line.trim()))
    .join('\n')
    .trim()

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The comparable body of a message: no reference lines, no embedded image
 *  payloads, whitespace-normalized. */
export const comparableText = (message: ChatMessage): string =>
  normalized(textWithoutReferenceLines(textWithoutEmbeddedImages(chatMessageText(message))))

/** Do these two user rows describe the same message the user sent? */
export const userMessagesMatch = (left: ChatMessage, right: ChatMessage): boolean =>
  left.role === 'user' && right.role === 'user' && comparableText(left) === comparableText(right)

/**
 * Is `next` a strict forward extension of `previous`?
 *
 * An EMPTY previous never qualifies. That is the whole guard: without it, an
 * empty answer accepts any flat inflight dump as its continuation, which is how
 * the dump ends up sandwiched between the structured rows it duplicates.
 */
export function isStrictAnswerTextExtension(next: string, previous: string): boolean {
  const n = next.trim()
  const p = previous.trim()

  return Boolean(p && n && n.startsWith(p))
}

/**
 * The live assistant row of the CURRENT turn, or null.
 *
 * Scanning back only to the latest user row matters: after a compression the
 * transcript can hold an unrelated settled row that happens to carry tool
 * calls, and treating that as "the current turn" grafts its work onto a turn it
 * had no part in.
 */
export function liveAssistantOfCurrentTurn(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]

    if (message.role === 'user') {
      return null
    }

    if (message.role === 'assistant' && isLiveTailRow(message)) {
      return message
    }
  }

  return null
}

/**
 * Should the flat `inflight.assistant` dump be projected at all?
 *
 * No, when the current turn already has a structured live row: the dump says
 * the same thing in a lossier way, and appending it sandwiches the reasoning
 * and tool rows between two renderings of one answer. An ERROR always projects
 * — a retained failed turn is the only record of that failure the client gets,
 * and it must surface even behind a healthy-looking structured row.
 */
export function shouldProjectInflightDump(messages: ChatMessage[], hasError: boolean): boolean {
  if (hasError) {
    return true
  }

  const live = liveAssistantOfCurrentTurn(messages)

  return !(live && hasStructuralParts(live))
}

/**
 * Is this user turn already in the transcript's latest run of user rows?
 *
 * Only the latest run, because the same words legitimately recur earlier in a
 * long conversation — matching those would suppress a real repeat.
 */
export function userTurnAlreadyPersisted(messages: ChatMessage[], text: string): boolean {
  const wanted = normalized(textWithoutReferenceLines(textWithoutEmbeddedImages(text)))

  if (!wanted) {
    return false
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]

    if (message.role !== 'user') {
      // Walk past assistant rows that belong to the same tail, but stop at a
      // settled one — beyond it is a different turn.
      if (message.role === 'assistant' && !isLiveTailRow(message)) {
        return false
      }

      continue
    }

    if (comparableText(message) === wanted) {
      return true
    }
  }

  return false
}

/**
 * Carry what the LOCAL row knows onto the authoritative one for the same turn.
 *
 * Two carries, both one-directional:
 *
 *  - structure (reasoning / tool-call parts) the authoritative row lacks;
 *  - the answer text, when the authoritative row does not strictly extend what
 *    we already rendered.
 *
 * Guarded by `isLiveTailRow(previous)` throughout: a settled historical row can
 * share a position with an unrelated new turn after a compression, and must not
 * lend it its tool calls or its prose.
 *
 * The TEXT carry is deliberately NOT gated on the local row having structure
 * (MJXHRM-358). A plain prose answer has no reasoning or tool parts at all, and
 * on the reconnect fold the local row is routinely AHEAD of the snapshot it is
 * being paired with — `store/turn-lifecycle.ts#reconcileSessionTail` computes
 * the merge after a slow resume round trip, and the router keeps folding deltas
 * into the slice for its whole duration. Bailing out there left the shorter
 * gateway dump as the paired row while `preserveLocalPendingTurnMessages` could
 * no longer recognise our longer copy as the same answer, so it appended it:
 * the answer printed twice, once truncated. Requiring BOTH rows to be live-tail
 * rows for the structure-less case is what keeps a committed history row from
 * ever being overwritten by a local one that merely shares its ordinal.
 */
export function preserveStructuralParts(authoritative: ChatMessage, previous: ChatMessage): ChatMessage {
  if (authoritative.role !== 'assistant' || previous.role !== 'assistant' || !isLiveTailRow(previous)) {
    return authoritative
  }

  const structural = previous.parts.filter(part => part.type === 'reasoning' || part.type === 'tool-call')
  const carriesStructure = structural.length > 0 && !hasStructuralParts(authoritative)

  const authoritativeText = chatMessageText(authoritative)
  const previousText = textWithoutEmbeddedImages(chatMessageText(previous))

  // A row that does not continue what we rendered is either a lossier
  // restatement of it (a flat dump beside our structured rows) or simply an
  // older snapshot of it — keep the text we have rather than replacing it.
  const keepsOurText =
    previousText.trim().length > 0 &&
    !isStrictAnswerTextExtension(authoritativeText, previousText) &&
    (carriesStructure || isLiveTailRow(authoritative))

  if (!carriesStructure && !keepsOurText) {
    return authoritative
  }

  const textParts = (keepsOurText ? previous : authoritative).parts.filter(part => part.type === 'text')

  return carriesStructure
    ? { ...authoritative, parts: [...structural, ...textParts] }
    : { ...authoritative, parts: [...authoritative.parts.filter(part => part.type !== 'text'), ...textParts] }
}

/**
 * Re-attach an image payload the round trip stripped.
 *
 * An image attachment renders optimistically from its inline `data:` URL so the
 * thumbnail is instant; the persisted copy usually comes back with the bytes
 * removed. Only repaired when the visible text is otherwise identical — a
 * different message is a different message.
 */
export function preserveEmbeddedImages(authoritative: ChatMessage, previous: ChatMessage): ChatMessage {
  const previousImages = embeddedImageUrls(chatMessageText(previous))

  if (previousImages.length === 0 || embeddedImageUrls(chatMessageText(authoritative)).length > 0) {
    return authoritative
  }

  if (comparableText(authoritative) !== comparableText(previous)) {
    return authoritative
  }

  return {
    ...authoritative,
    parts: [...authoritative.parts, { type: 'text', text: previousImages.map(url => `\n${url}`).join('') }]
  }
}

/**
 * Fold the local transcript's knowledge into an authoritative one, pairing rows
 * by ROLE ORDINAL — the nth user row against the nth user row.
 *
 * Ordinals rather than ids because the authoritative copy has committed ids the
 * optimistic rows never had.
 */
export function reconcileResumeMessages(authoritative: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  if (previous.length === 0) {
    return authoritative
  }

  const byRole = new Map<string, ChatMessage[]>()

  for (const message of previous) {
    const bucket = byRole.get(message.role) ?? []
    bucket.push(message)
    byRole.set(message.role, bucket)
  }

  const seen = new Map<string, number>()
  let changed = false

  const reconciled = authoritative.map(message => {
    const ordinal = seen.get(message.role) ?? 0
    seen.set(message.role, ordinal + 1)

    const local = byRole.get(message.role)?.[ordinal]

    if (!local) {
      return message
    }

    const next =
      message.role === 'assistant'
        ? preserveStructuralParts(message, local)
        : message.role === 'user'
          ? preserveEmbeddedImages(message, local)
          : message

    if (next !== message) {
      changed = true
    }

    return next
  })

  return changed ? reconciled : authoritative
}

/**
 * Re-attach local rows the authoritative transcript does not have yet.
 *
 * The one that matters is the SETTLED local reply: while the turn was
 * finishing, the commit shifted it one ordinal earlier, and re-appending it
 * blindly renders the same answer twice. So a settled local row whose body
 * already appears in the authoritative set is DROPPED, and only a row nothing
 * else holds is carried over — it is the only copy.
 *
 * "Already appears" has to include CONTINUES, not just equals. The authoritative
 * assistant row for a still-running turn is a snapshot taken later than ours, so
 * it routinely reads as the same answer plus more of it — and `reconcileResumeMessages`
 * has by then already carried our reasoning and tool parts onto it. Re-appending
 * the prefix we rendered would print the answer twice, once truncated, which is
 * the exact sandwich this module exists to prevent. Restricted to assistant rows:
 * one user message being a prefix of another is a coincidence, not a continuation.
 */
export function preserveLocalPendingTurnMessages(authoritative: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const tail: ChatMessage[] = []
  const ids = new Set(authoritative.map(message => message.id))

  for (const message of previous) {
    if (!isLiveTailRow(message) || ids.has(message.id)) {
      continue
    }

    const body = comparableText(message)

    // The finished (or continued) reply already landed under its committed id —
    // this is the stale optimistic twin, not a second answer.
    if (
      body &&
      authoritative.some(candidate => {
        if (candidate.role !== message.role) {
          return false
        }

        const candidateBody = comparableText(candidate)

        return (
          candidateBody === body || (message.role === 'assistant' && isStrictAnswerTextExtension(candidateBody, body))
        )
      })
    ) {
      continue
    }

    tail.push(message)
  }

  return tail.length > 0 ? [...authoritative, ...tail] : authoritative
}

/**
 * THE live-tail reconciliation: an authoritative transcript, folded together
 * with what the local slice knows about the turn still running.
 */
export function reconcileLiveTail(authoritative: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  return preserveLocalPendingTurnMessages(reconcileResumeMessages(authoritative, previous), previous)
}
