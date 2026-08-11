/**
 * The crash-survivable in-flight turn journal.
 *
 * The gateway keeps its own `inflight` snapshot, and that covers a RECONNECT:
 * the socket drops, the backend keeps running, and `session.resume` hands the
 * turn back. It does not cover the app dying, because that snapshot is
 * text-only — `{user, assistant}` strings — and because a hard crash of the
 * backend takes it with it.
 *
 * This is the other half. While a turn is live, the visible tail of it — the
 * prompt, any corrections, and the streaming assistant row WITH its reasoning
 * and tool calls — is written to localStorage. On the next resume it is folded
 * back onto whatever the backend returns, so a turn killed mid-run comes back
 * as what the user was watching rather than a blank gap.
 *
 * Everything here is best-effort by design: a storage failure must never break
 * a live turn.
 */

import { type ChatMessage, chatMessageText, type ChatPart } from '@/lib/chat-messages'

const STORAGE_KEY = 'hermes.universal.inflightTurnJournal.v1'
const STORE_VERSION = 1

/** Journals older than this are not worth restoring — the conversation has
 *  moved on, and re-injecting a week-old tail is worse than a gap. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Cap on journaled sessions. Bounded storage, oldest evicted first. */
const MAX_ENTRIES = 24

/**
 * Streaming repaints arrive every few milliseconds and `localStorage.setItem`
 * is synchronous — writing per repaint would put a blocking disk write on the
 * token path. A trailing-edge throttle keeps the cost off it.
 */
const PERSIST_THROTTLE_MS = 400

export interface InFlightTurnSnapshot {
  messages: ChatMessage[]
  /** The slice's live stream id at journal time. Restoring it is what points
   *  the next turn's deltas at the recovered row instead of a fresh bubble. */
  streamId: null | string
  turnStartedAt: null | number
  updatedAt: number
}

/** The slice fields the journal reads. Structural, so any session-shaped
 *  object can be journaled without this module importing the store. */
export interface JournalableSessionState {
  awaitingResponse: boolean
  busy: boolean
  messages: ChatMessage[]
  storedSessionId: null | string
  streamId: null | string
  turnStartedAt: null | number
}

export interface InFlightRecoveryResult {
  /** The journal contributed rows the base transcript did not have. */
  applied: boolean
  /** The base transcript already contains this turn — the entry is spent. */
  caughtUp: boolean
  messages: ChatMessage[]
  /** The id live deltas should target after the fold, or null. */
  streamId: null | string
  turnStartedAt: null | number
}

interface JournalStore {
  entries: Record<string, InFlightTurnSnapshot>
  version: number
}

// --- storage ---------------------------------------------------------------

const emptyStore = (): JournalStore => ({ entries: {}, version: STORE_VERSION })

const isExpired = (snapshot: InFlightTurnSnapshot, now: number): boolean => now - snapshot.updatedAt > MAX_AGE_MS

/**
 * Which sessions have an entry — an in-memory mirror of the store's KEYS.
 *
 * `persistInFlightTurnState` is called for every session on every state
 * commit, and its dominant case by far is "this session is idle, clear it".
 * Answering that from storage means a synchronous `getItem` + `JSON.parse` of
 * the whole journal PER IDLE SESSION PER DELTA — the same blocking read the
 * write path goes to such lengths to throttle off the token path. The key set
 * answers it for free, and only a real hit pays for the parse.
 *
 * `null` means "not hydrated yet"; a `storage` event from another window
 * invalidates it (see below), so a second window's write is never masked.
 */
let indexedIds: null | Set<string> = null

function knownIds(): Set<string> {
  if (!indexedIds) {
    indexedIds = new Set(Object.keys(loadStore().entries))
  }

  return indexedIds
}

if (typeof window !== 'undefined') {
  // Satellite windows share this origin, and therefore this key. Whoever wrote
  // last is authoritative; drop the mirror rather than trusting our own view of
  // a blob someone else just rewrote.
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === STORAGE_KEY) {
      indexedIds = null
    }
  })
}

function loadStore(): JournalStore {
  if (typeof window === 'undefined') {
    return emptyStore()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<JournalStore>) : null

    if (!parsed || parsed.version !== STORE_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) {
      return emptyStore()
    }

    return { entries: parsed.entries, version: STORE_VERSION }
  } catch {
    return emptyStore()
  }
}

function saveStore(store: JournalStore): void {
  if (typeof window === 'undefined') {
    return
  }

  const now = Date.now()

  const kept = Object.entries(store.entries)
    .filter(([, snapshot]) => !isExpired(snapshot, now))
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES)

  indexedIds = new Set(kept.map(([id]) => id))

  try {
    if (kept.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)

      return
    }

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ entries: Object.fromEntries(kept), version: STORE_VERSION })
    )
  } catch {
    /* storage full or unavailable — the live turn is unaffected */
  }
}

// --- the recoverable tail --------------------------------------------------

/** Does this assistant row carry anything a resume could not rebuild itself? */
function assistantHasRecoverableContent(message: ChatMessage): boolean {
  if (message.error) {
    return true
  }

  return message.parts.some(part =>
    part.type === 'tool-call' ? true : 'text' in part && typeof part.text === 'string' && part.text.trim().length > 0
  )
}

const isLiveTailRow = (message: ChatMessage): boolean =>
  message.pending === true || message.id.startsWith('assistant-stream-') || message.id.startsWith('user-inflight-')

/**
 * The rows belonging to the turn still in flight: the assistant row being
 * streamed, plus the user rows that opened the turn.
 *
 * The plural matters. A mid-turn correction inserts ANOTHER user row right
 * before the live reply, so a turn can open with a RUN of user rows — stopping
 * at the nearest one journals the correction alone and loses the prompt that
 * actually started the turn.
 */
export function recoverableTail(messages: ChatMessage[]): ChatMessage[] {
  let assistantIndex = -1

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]

    if (message.role === 'user') {
      break
    }

    if (message.role === 'assistant' && assistantHasRecoverableContent(message)) {
      assistantIndex = i

      break
    }
  }

  if (assistantIndex < 0) {
    return []
  }

  let start = assistantIndex

  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      start = i

      while (start > 0 && messages[start - 1].role === 'user') {
        start -= 1
      }

      break
    }
  }

  return messages.slice(start, assistantIndex + 1)
}

// --- the merge -------------------------------------------------------------

const normalizedText = (text: string): string => text.replace(/\s+/g, ' ').trim()

const userMessagesMatch = (left: ChatMessage, right: ChatMessage): boolean =>
  left.role === 'user' &&
  right.role === 'user' &&
  normalizedText(chatMessageText(left)) === normalizedText(chatMessageText(right))

/** Rows the base transcript already holds under the same id — re-appending one
 *  renders the same bubble twice. */
const withoutBaseIds = (rows: ChatMessage[], base: ChatMessage[]): ChatMessage[] => {
  const ids = new Set(base.map(message => message.id))

  return rows.filter(row => !ids.has(row.id))
}

/**
 * A journaled row was captured mid-stream, so it carries `pending: true`.
 *
 * Whether it may KEEP that flag depends on something the journal cannot know:
 * is the turn still running? On a reconnect, yes — the row is about to receive
 * more deltas. After a crash that took the backend with it, no — and a pending
 * row nothing will ever complete renders as a bubble that spins forever, with
 * no stop button beside it because the slice is idle.
 */
const sealTail = (tail: ChatMessage[], keepPending: boolean): ChatMessage[] =>
  tail.map(message =>
    message.role === 'assistant'
      ? { ...message, pending: keepPending ? (message.pending ?? true) : false }
      : { ...message, pending: false }
  )

const hasStructuralParts = (message: ChatMessage): boolean =>
  message.parts.some(part => part.type === 'reasoning' || part.type === 'tool-call')

/**
 * Fold the journal's structure onto the backend's live projection row.
 *
 * The two carry different things: the journal has the reasoning and tool calls
 * the text-only snapshot cannot express, while the snapshot's TEXT may be newer
 * than the journal's last throttled write. Taking the journal's parts wholesale
 * therefore silently rolled back up to 400ms of the answer.
 *
 * When the journal already carries structure, only a strict EXTENSION of its
 * answer text is accepted: the snapshot is a flat dump that begins with the
 * turn's thinking, and grafting that in as answer text puts the model's
 * scratchpad in the reply.
 */
function overlayProjectionRow(projection: ChatMessage, journalRow: ChatMessage): ChatMessage {
  const error = journalRow.error ?? projection.error

  const merged: ChatMessage = {
    ...journalRow,
    id: projection.id,
    pending: projection.pending,
    ...(error ? { error } : {})
  }

  const projectionText = chatMessageText(projection)
  const journalText = chatMessageText(journalRow)

  if (projectionText.length <= journalText.length) {
    return merged
  }

  // With structure in hand, only a strict EXTENSION of the answer text is
  // accepted. No answer text yet means everything in the flat dump so far is
  // thinking, and grafting that in would publish the model's scratchpad.
  if (
    hasStructuralParts(journalRow) &&
    (!journalText.trim() || !projectionText.trim().startsWith(journalText.trim()))
  ) {
    return merged
  }

  const parts: ChatPart[] = []
  let replaced = false

  for (const part of journalRow.parts) {
    if (part.type !== 'text') {
      parts.push(part)
    } else if (!replaced) {
      parts.push({ ...part, text: projectionText })
      replaced = true
    }
  }

  if (!replaced) {
    parts.push({ type: 'text', text: projectionText })
  }

  return { ...merged, parts }
}

/**
 * Fold a journaled tail onto a freshly-hydrated transcript.
 *
 * Three outcomes:
 *
 *  - The base does not know the turn at all (nothing was committed before the
 *    crash) → append the whole tail.
 *  - The base knows the turn AND already has a settled reply for it → the
 *    journal is spent (`caughtUp`); the caller drops the entry.
 *  - The base has the turn with only a live projection row → overlay the
 *    journal's structure onto it, keeping the projection's id so streaming
 *    deltas keep landing on the same row.
 */
export function mergeInFlightMessages(
  base: ChatMessage[],
  journaled: ChatMessage[],
  options: { keepPending?: boolean } = {}
): InFlightRecoveryResult {
  const settled: InFlightRecoveryResult = {
    applied: false,
    caughtUp: false,
    messages: base,
    streamId: null,
    turnStartedAt: null
  }

  const tail = sealTail(journaled, Boolean(options.keepPending))
  const tailUserIndex = tail.findIndex(message => message.role === 'user')
  const tailUser = tailUserIndex >= 0 ? tail[tailUserIndex] : null
  const tailAssistants = tail.filter(message => message.role === 'assistant' && assistantHasRecoverableContent(message))

  if (tailAssistants.length === 0) {
    return settled
  }

  // Match the turn's opening prompt against the base, most recent first — the
  // same prompt can legitimately appear earlier in a long conversation.
  let baseUserIndex = -1

  if (tailUser) {
    for (let i = base.length - 1; i >= 0; i -= 1) {
      if (userMessagesMatch(base[i], tailUser)) {
        baseUserIndex = i

        break
      }
    }
  }

  const journalRow = tailAssistants[tailAssistants.length - 1]

  if (baseUserIndex < 0) {
    // The turn never reached the backend's history at all. The journal is the
    // only copy of it.
    const rows = withoutBaseIds(tail, base)

    return rows.length > 0
      ? { applied: true, caughtUp: false, messages: [...base, ...rows], streamId: journalRow.id, turnStartedAt: null }
      : settled
  }

  const after = base.slice(baseUserIndex + 1)
  const projectionIndex = after.findIndex(message => message.role === 'assistant' && isLiveTailRow(message))

  // A settled reply only counts when it SAYS something. An empty assistant
  // boundary row — the one `appendLiveSessionProjection` seeds before the first
  // delta of a queued turn — used to satisfy this test and throw the journal
  // away as "already on screen", leaving the crashed turn represented by a
  // blank bubble.
  const settledReply = after.some(
    message => message.role === 'assistant' && !isLiveTailRow(message) && assistantHasRecoverableContent(message)
  )

  if (settledReply) {
    // The turn finished and committed while we were away. Anything the journal
    // still holds is a partial copy of a reply that is already on screen.
    return { ...settled, caughtUp: true }
  }

  if (projectionIndex < 0) {
    const rows = withoutBaseIds(tailAssistants, base)

    return rows.length > 0
      ? {
          applied: true,
          caughtUp: false,
          messages: [...base, ...rows],
          streamId: rows[rows.length - 1].id,
          turnStartedAt: null
        }
      : settled
  }

  // The backend's projection is TEXT-ONLY — its snapshot cannot express the
  // reasoning and tool calls the user watched happen. Keep the journal's parts
  // but the projection's id, so live deltas keep targeting the same row.
  const at = baseIndexOfProjection(base, baseUserIndex, projectionIndex)
  const merged = base.slice()
  merged[at] = overlayProjectionRow(base[at], journalRow)

  return { applied: true, caughtUp: false, messages: merged, streamId: merged[at].id, turnStartedAt: null }
}

const baseIndexOfProjection = (base: ChatMessage[], baseUserIndex: number, offset: number): number =>
  Math.min(baseUserIndex + 1 + offset, base.length - 1)

// --- the public API --------------------------------------------------------

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const persistLatest = new Map<string, JournalableSessionState>()

function writeSnapshot(storedSessionId: string, state: JournalableSessionState): void {
  const tail = recoverableTail(state.messages)

  if (tail.length === 0) {
    return
  }

  const store = loadStore()

  store.entries[storedSessionId] = {
    messages: JSON.parse(JSON.stringify(tail)) as ChatMessage[],
    streamId: state.streamId,
    turnStartedAt: state.turnStartedAt,
    updatedAt: Date.now()
  }

  saveStore(store)
}

/**
 * Journal a session's live turn. Safe to call on every state commit: a settled
 * turn clears its entry immediately, and a live one coalesces through a
 * trailing throttle.
 */
export function persistInFlightTurnState(state: JournalableSessionState): void {
  const storedSessionId = state.storedSessionId

  if (!storedSessionId) {
    return
  }

  // `busy` alone is not "the turn is over". A submit that has left but not been
  // acknowledged is `awaitingResponse` with `busy` still settling, and a stream
  // still bound to a row keeps `streamId`. Clearing on `busy` alone threw the
  // journal away in exactly those windows — which are the windows a crash is
  // most likely to land in.
  if (!state.busy && !state.awaitingResponse && !state.streamId) {
    clearInFlightTurnJournal(storedSessionId)

    return
  }

  persistLatest.set(storedSessionId, state)

  if (persistTimers.has(storedSessionId)) {
    return
  }

  persistTimers.set(
    storedSessionId,
    setTimeout(() => {
      persistTimers.delete(storedSessionId)
      const latest = persistLatest.get(storedSessionId)
      persistLatest.delete(storedSessionId)

      if (latest) {
        writeSnapshot(storedSessionId, latest)
      }
    }, PERSIST_THROTTLE_MS)
  )
}

/** The journaled tail for a session, or null. Expired entries are pruned. */
export function readInFlightTurnJournal(storedSessionId: null | string): InFlightTurnSnapshot | null {
  if (!storedSessionId) {
    return null
  }

  const store = loadStore()
  const snapshot = store.entries[storedSessionId]

  if (!snapshot) {
    return null
  }

  if (isExpired(snapshot, Date.now())) {
    delete store.entries[storedSessionId]
    saveStore(store)

    return null
  }

  return snapshot
}

export function clearInFlightTurnJournal(storedSessionId: null | string): void {
  if (!storedSessionId) {
    return
  }

  const timer = persistTimers.get(storedSessionId)

  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(storedSessionId)
  }

  persistLatest.delete(storedSessionId)

  // The overwhelmingly common call: an idle session, on every state commit.
  // Answer it from the key mirror so the hot path never parses the blob.
  if (!knownIds().has(storedSessionId)) {
    return
  }

  const store = loadStore()

  if (storedSessionId in store.entries) {
    delete store.entries[storedSessionId]
    saveStore(store)
  } else {
    indexedIds = new Set(Object.keys(store.entries))
  }
}

/** Test hook — drop the in-memory key mirror so a test that writes storage
 *  directly is not answered from a stale view of it. */
export function __resetInFlightTurnJournalCache(): void {
  indexedIds = null

  for (const timer of persistTimers.values()) {
    clearTimeout(timer)
  }

  persistTimers.clear()
  persistLatest.clear()
}

/**
 * Fold a session's journal onto a freshly-hydrated transcript.
 *
 * The entry is dropped once it is SPENT — either the base transcript already
 * caught up, or the fold succeeded and there is nothing left to replay. An
 * applied entry that survived would be re-injected on every later cold open of
 * the same session, for the whole seven-day TTL, because the rows it appends
 * are local-only and never come back from the backend to satisfy `caughtUp`.
 *
 * `keepPending` says whether the turn is still running (the backend's resume
 * says so). Only then may a recovered assistant row stay pending.
 */
export function recoverInFlightTurnJournal(
  storedSessionId: null | string,
  base: ChatMessage[],
  options: { keepPending?: boolean } = {}
): InFlightRecoveryResult {
  const snapshot = readInFlightTurnJournal(storedSessionId)

  if (!snapshot) {
    return { applied: false, caughtUp: false, messages: base, streamId: null, turnStartedAt: null }
  }

  const result = mergeInFlightMessages(base, snapshot.messages, options)

  if (result.caughtUp || (result.applied && !options.keepPending)) {
    clearInFlightTurnJournal(storedSessionId)
  }

  return {
    ...result,
    streamId: result.applied ? (result.streamId ?? snapshot.streamId) : null,
    turnStartedAt: result.applied ? snapshot.turnStartedAt : null
  }
}
