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

import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'

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
  turnStartedAt: null | number
  updatedAt: number
}

/** The slice fields the journal reads. Structural, so any session-shaped
 *  object can be journaled without this module importing the store. */
export interface JournalableSessionState {
  busy: boolean
  messages: ChatMessage[]
  storedSessionId: null | string
  turnStartedAt: null | number
}

export interface InFlightRecoveryResult {
  /** The journal contributed rows the base transcript did not have. */
  applied: boolean
  /** The base transcript already contains this turn — the entry is spent. */
  caughtUp: boolean
  messages: ChatMessage[]
  turnStartedAt: null | number
}

interface JournalStore {
  entries: Record<string, InFlightTurnSnapshot>
  version: number
}

// --- storage ---------------------------------------------------------------

const emptyStore = (): JournalStore => ({ entries: {}, version: STORE_VERSION })

const isExpired = (snapshot: InFlightTurnSnapshot, now: number): boolean => now - snapshot.updatedAt > MAX_AGE_MS

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
export function mergeInFlightMessages(base: ChatMessage[], tail: ChatMessage[]): InFlightRecoveryResult {
  const settled: InFlightRecoveryResult = { applied: false, caughtUp: false, messages: base, turnStartedAt: null }

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

  if (baseUserIndex < 0) {
    // The turn never reached the backend's history at all. The journal is the
    // only copy of it.
    const rows = withoutBaseIds(tail, base)

    return rows.length > 0
      ? { applied: true, caughtUp: false, messages: [...base, ...rows], turnStartedAt: null }
      : settled
  }

  const after = base.slice(baseUserIndex + 1)
  const projectionIndex = after.findIndex(message => message.role === 'assistant' && isLiveTailRow(message))
  const settledReply = after.some(message => message.role === 'assistant' && !isLiveTailRow(message))

  if (settledReply) {
    // The turn finished and committed while we were away. Anything the journal
    // still holds is a partial copy of a reply that is already on screen.
    return { ...settled, caughtUp: true }
  }

  const journalRow = tailAssistants[tailAssistants.length - 1]

  if (projectionIndex < 0) {
    const rows = withoutBaseIds(tailAssistants, base)

    return rows.length > 0
      ? { applied: true, caughtUp: false, messages: [...base, ...rows], turnStartedAt: null }
      : settled
  }

  // The backend's projection is TEXT-ONLY — its snapshot cannot express the
  // reasoning and tool calls the user watched happen. Keep the journal's parts
  // but the projection's id, so live deltas keep targeting the same row.
  const at = baseIndexOfProjection(base, baseUserIndex, projectionIndex)
  const projection = base[at]
  const merged = base.slice()
  merged[at] = { ...projection, error: projection.error ?? journalRow.error, parts: journalRow.parts }

  return { applied: true, caughtUp: false, messages: merged, turnStartedAt: null }
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

  if (!state.busy) {
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

  const store = loadStore()

  if (storedSessionId in store.entries) {
    delete store.entries[storedSessionId]
    saveStore(store)
  }
}

/**
 * Fold a session's journal onto a freshly-hydrated transcript. The entry is
 * dropped when the base transcript has already caught up.
 */
export function recoverInFlightTurnJournal(
  storedSessionId: null | string,
  base: ChatMessage[]
): InFlightRecoveryResult {
  const snapshot = readInFlightTurnJournal(storedSessionId)

  if (!snapshot) {
    return { applied: false, caughtUp: false, messages: base, turnStartedAt: null }
  }

  const result = mergeInFlightMessages(base, snapshot.messages)

  if (result.caughtUp) {
    clearInFlightTurnJournal(storedSessionId)
  }

  return { ...result, turnStartedAt: result.applied ? snapshot.turnStartedAt : null }
}
