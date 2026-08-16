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

/**
 * ONE localStorage key PER SESSION.
 *
 * v1 kept every session's tail in a single key, so each throttled write
 * re-parsed and re-stringified EVERY busy session's snapshot. With one chat that
 * is invisible; with a grid of tiles streaming at once it is a whole-store JSON
 * round trip several times a second, synchronously, on the token path — the
 * exact cost the throttle above exists to keep off it. Per-session keys make a
 * write O(this session's tail) no matter how many others are streaming.
 *
 * (Universal's own shape of upstream `3139a30e52`. The other two thirds of that
 * commit — slice eviction and lineage-alias indexing — universal already solves
 * differently: `pruneSessionStates` caps the map, and `keyByStoredId` is already
 * an O(1) index.)
 */
const STORAGE_PREFIX = 'hermes.universal.inflightTurnJournal.v2:'

/** The single-key v1 store. Migrated on first touch, then removed — a crash
 *  that happened before the upgrade must still be recoverable after it. */
const LEGACY_STORAGE_KEY = 'hermes.universal.inflightTurnJournal.v1'

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

// --- storage ---------------------------------------------------------------

const isExpired = (snapshot: InFlightTurnSnapshot, now: number): boolean => now - snapshot.updatedAt > MAX_AGE_MS

const entryKey = (storedSessionId: string): string => `${STORAGE_PREFIX}${storedSessionId}`

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // A blocked-storage origin throws on ACCESS, not on use.
    return null
  }
}

/**
 * Which sessions have an entry — an in-memory mirror of the store's KEYS.
 *
 * `persistInFlightTurnState` is called for every session on every state commit,
 * and its dominant case by far is "this session is idle, clear it". The mirror
 * answers that without going to storage at all; only a real hit pays for a
 * `removeItem`.
 *
 * `null` means "not hydrated yet"; a `storage` event from another window
 * invalidates it (see below), so a second window's write is never masked.
 */
let indexedIds: null | Set<string> = null

/** Expiry/overflow pruning and the v1 migration: once per renderer, on the
 *  first touch of the journal rather than at import, so a module that is only
 *  imported for its pure merge helpers pays nothing. */
let housekeepingDone = false

function journalKeys(store: Storage): string[] {
  const keys: string[] = []

  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)

    if (key?.startsWith(STORAGE_PREFIX)) {
      keys.push(key)
    }
  }

  return keys
}

function migrateLegacyStore(store: Storage): void {
  const raw = store.getItem(LEGACY_STORAGE_KEY)

  if (!raw) {
    return
  }

  store.removeItem(LEGACY_STORAGE_KEY)

  const parsed = JSON.parse(raw) as { entries?: Record<string, InFlightTurnSnapshot> }

  for (const [storedSessionId, snapshot] of Object.entries(parsed?.entries ?? {})) {
    if (snapshot && typeof snapshot.updatedAt === 'number' && Array.isArray(snapshot.messages)) {
      store.setItem(entryKey(storedSessionId), JSON.stringify(snapshot))
    }
  }
}

function ensureHousekeeping(): void {
  if (housekeepingDone) {
    return
  }

  housekeepingDone = true

  const store = storage()

  if (!store) {
    return
  }

  try {
    migrateLegacyStore(store)

    const now = Date.now()
    const live: { key: string; updatedAt: number }[] = []

    for (const key of journalKeys(store)) {
      let snapshot: InFlightTurnSnapshot | null = null

      try {
        snapshot = JSON.parse(store.getItem(key) ?? '') as InFlightTurnSnapshot
      } catch {
        /* unparseable — pruned below */
      }

      if (!snapshot || typeof snapshot.updatedAt !== 'number' || isExpired(snapshot, now)) {
        store.removeItem(key)
      } else {
        live.push({ key, updatedAt: snapshot.updatedAt })
      }
    }

    // Bounded storage, oldest evicted first.
    live.sort((a, b) => b.updatedAt - a.updatedAt)

    for (const { key } of live.slice(MAX_ENTRIES)) {
      store.removeItem(key)
    }
  } catch {
    /* best-effort, like every other journal write */
  }
}

function knownIds(): Set<string> {
  ensureHousekeeping()

  if (!indexedIds) {
    const store = storage()

    // Keys only — no `getItem`, no parse. This is the whole point of the mirror.
    indexedIds = new Set(store ? journalKeys(store).map(key => key.slice(STORAGE_PREFIX.length)) : [])
  }

  return indexedIds
}

if (typeof window !== 'undefined') {
  // Satellite windows share this origin, and therefore these keys. Whoever wrote
  // last is authoritative; drop the mirror rather than trusting our own view of
  // a key someone else just wrote or removed.
  window.addEventListener('storage', event => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) {
      indexedIds = null
    }
  })
}

function loadEntry(storedSessionId: string): InFlightTurnSnapshot | null {
  ensureHousekeeping()

  const store = storage()

  if (!store) {
    return null
  }

  try {
    const raw = store.getItem(entryKey(storedSessionId))
    const parsed = raw ? (JSON.parse(raw) as InFlightTurnSnapshot) : null

    return parsed && typeof parsed.updatedAt === 'number' && Array.isArray(parsed.messages) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Sessions THIS window journaled — a subset of `knownIds()`, which is every
 * session any window journaled (MJXHRM-374).
 *
 * These keys are shared by every window of the origin, but a turn is not: the
 * gateway binds a session's stream to ONE connection, so exactly one window is
 * ever watching a given turn run. Every other window holds a slice for that
 * session which is, from where it sits, perfectly settled — and "settled" is the
 * condition on which `persistInFlightTurnState` and the turn-lifecycle observer
 * DELETE the entry. So a HUD summoned onto a conversation, a detached tile
 * window, or a second app window could each throw away the live crash journal of
 * a turn running in the window next to it, and the crash it was written for
 * would then recover nothing.
 *
 * Hence: a window may only release what it wrote. Recovery still drops any
 * entry it folds in (`removeEntry` below), so an entry whose window went away
 * without settling is reclaimed the next time that session is opened rather
 * than leaking to the 7-day TTL.
 */
const writtenHere = new Set<string>()

function saveEntry(storedSessionId: string, snapshot: InFlightTurnSnapshot): void {
  knownIds().add(storedSessionId)
  writtenHere.add(storedSessionId)

  try {
    storage()?.setItem(entryKey(storedSessionId), JSON.stringify(snapshot))
  } catch {
    /* storage full or unavailable — the live turn is unaffected */
  }
}

function removeEntry(storedSessionId: string): void {
  knownIds().delete(storedSessionId)
  writtenHere.delete(storedSessionId)

  try {
    storage()?.removeItem(entryKey(storedSessionId))
  } catch {
    /* best-effort */
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

  saveEntry(storedSessionId, {
    messages: JSON.parse(JSON.stringify(tail)) as ChatMessage[],
    streamId: state.streamId,
    turnStartedAt: state.turnStartedAt,
    updatedAt: Date.now()
  })
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
    releaseInFlightTurnJournal(storedSessionId)

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

  const snapshot = loadEntry(storedSessionId)

  if (!snapshot) {
    return null
  }

  if (isExpired(snapshot, Date.now())) {
    removeEntry(storedSessionId)

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
  // Answer it from the key mirror so the hot path never touches storage at all.
  if (!knownIds().has(storedSessionId)) {
    return
  }

  removeEntry(storedSessionId)
}

/**
 * "This window's turn for `storedSessionId` is over" — the settle path, as
 * opposed to `clearInFlightTurnJournal`'s unconditional "this entry is spent".
 *
 * A session THIS window never journaled is one whose turn is running (or ran)
 * somewhere else, and a window that never watched a turn has no standing to
 * decide it finished. A pending throttled write counts as ours: the entry is a
 * few hundred milliseconds from existing, and cancelling that timer is exactly
 * what a settle before it fires has to do.
 */
export function releaseInFlightTurnJournal(storedSessionId: null | string): void {
  if (!storedSessionId || (!writtenHere.has(storedSessionId) && !persistTimers.has(storedSessionId))) {
    return
  }

  clearInFlightTurnJournal(storedSessionId)
}

/** Test hook — drop the in-memory key mirror so a test that writes storage
 *  directly is not answered from a stale view of it. */
export function __resetInFlightTurnJournalCache(): void {
  indexedIds = null
  housekeepingDone = false

  for (const timer of persistTimers.values()) {
    clearTimeout(timer)
  }

  persistTimers.clear()
  persistLatest.clear()
  writtenHere.clear()
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
