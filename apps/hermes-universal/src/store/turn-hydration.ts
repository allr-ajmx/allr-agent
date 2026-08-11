/**
 * THE hydration seam: what happens to a turn when an authoritative transcript
 * arrives to replace the one we were streaming into.
 *
 * A cold open resolves REST history plus `session.resume` and then `rekeySession`s
 * the result onto the runtime id — overwriting whatever the placeholder slice
 * held. That is the exact moment three things must happen, in order:
 *
 *  1. RECONCILE the local tail against the authoritative transcript
 *     (`lib/live-tail.ts`) — the local slice is the only place the running
 *     turn's reasoning and tool calls exist, and the backend's snapshot is a
 *     flat pair of strings that cannot express them.
 *  2. RECOVER the crash journal (`lib/inflight-turn-journal.ts`) for the turn
 *     that never got an authoritative anything, because the app died mid-run.
 *  3. Keep JOURNALING, which every republish of `$sessionStates` feeds.
 *
 * All three hang off store-layer seams rather than any one screen, and the
 * ordering is why they live in one module: reconciling after recovering would
 * fold the journal's rows in and then compare them against themselves.
 */

import {
  clearInFlightTurnJournal,
  persistInFlightTurnState,
  recoverInFlightTurnJournal
} from '@/lib/inflight-turn-journal'
import { reconcileLiveTail } from '@/lib/live-tail'
import {
  $sessionStates,
  addSessionKeyHooks,
  type ClientSessionState,
  isPlaceholderKey,
  updateSession
} from '@/store/session-state-types'
import { observeTurnLifecycle } from '@/store/turn-lifecycle'

// Sessions this process has already offered a recovery to. A session that
// rekeys twice (a resume that rotated the runtime id again) must not re-inject
// a tail the first recovery already merged.
const recovered = new Set<string>()

// The slice each session was last journaled from. `$sessionStates` republishes
// the WHOLE map on every delta, so without this every idle session pays the
// journal's bookkeeping on every token of every other session's turn.
const journaledFrom = new Map<string, ClientSessionState>()

let journalPassQueued = false

function runJournalPass(): void {
  const states = $sessionStates.get()

  for (const [key, state] of Object.entries(states)) {
    if (!state.storedSessionId || journaledFrom.get(key) === state) {
      continue
    }

    journaledFrom.set(key, state)
    persistInFlightTurnState({
      awaitingResponse: state.awaitingResponse,
      busy: state.busy,
      messages: state.messages,
      storedSessionId: state.storedSessionId,
      streamId: state.streamId,
      turnStartedAt: state.turnStartedAt
    })
  }

  for (const key of journaledFrom.keys()) {
    if (!(key in states)) {
      journaledFrom.delete(key)
    }
  }
}

/**
 * DEFERRED, and that is load-bearing.
 *
 * `rekeySession` publishes the moved slice and only THEN fires the key hooks,
 * and nanostores notifies synchronously — so a subscriber that journals inline
 * runs BEFORE the `rekey` hook below. A cold open rekeys with
 * `busy: stillRunning`, which is false for exactly the case this journal
 * exists for (the app died and took its turn with it), so the inline version
 * cleared the entry a few statements before recovery went looking for it.
 * Recovery therefore only ever succeeded when the backend still had the turn —
 * the one case the gateway's own `inflight` snapshot already covered.
 *
 * A microtask lands after `rekeySession` has run to completion, so the hook
 * reads a journal that is still there and the settle-clear happens after, on
 * an entry recovery has already consumed.
 */
$sessionStates.subscribe(() => {
  if (journalPassQueued) {
    return
  }

  journalPassQueued = true

  queueMicrotask(() => {
    journalPassQueued = false
    runJournalPass()
  })
})

addSessionKeyHooks({
  drop: () => {
    // The slice is gone but the journal is not the slice: it exists precisely
    // to outlive one. Eviction is not "the turn ended".
  },
  rekey: (fromKey, toKey, previous) => {
    // Only a HYDRATING key binding its runtime id is a cold open. A draft
    // promoting to a real session has nothing authoritative to reconcile
    // against, and a live rekey is carrying a turn we are already streaming.
    if (!isPlaceholderKey(fromKey) || isPlaceholderKey(toKey)) {
      return
    }

    const state = $sessionStates.get()[toKey]
    const storedSessionId = state?.storedSessionId

    if (!state) {
      return
    }

    // (1) The authoritative transcript, folded together with what the local
    // slice knew about the turn still running.
    const reconciled = reconcileLiveTail(state.messages, previous.messages)

    // (2) The crash journal, for a turn the backend has no record of at all.
    const alreadyRecovered = !storedSessionId || recovered.has(storedSessionId)

    if (storedSessionId) {
      recovered.add(storedSessionId)
    }

    // `busy` at this instant IS the backend's answer to "is the turn still
    // running" — the cold-open rekey patches it from `resumed.inflight`. Only
    // a running turn may keep the journaled row pending; a dead one has to be
    // sealed or it renders as a bubble that spins with no stop button beside it.
    const stillRunning = state.busy

    const result = alreadyRecovered
      ? { applied: false, messages: reconciled, streamId: null, turnStartedAt: null }
      : recoverInFlightTurnJournal(storedSessionId, reconciled, { keepPending: stillRunning })

    const messages = result.applied ? result.messages : reconciled

    if (messages === state.messages && !result.applied) {
      return
    }

    updateSession(toKey, current => ({
      ...current,
      messages,
      ...(result.applied
        ? {
            // The recovered rows ARE assistant payload; without this the stall
            // watchdog treats the resumed turn as one that never said anything.
            sawAssistantPayload: true,
            // Point live deltas at the recovered row, but only while the turn
            // can still produce them.
            ...(stillRunning && result.streamId ? { streamId: result.streamId } : {}),
            ...(result.turnStartedAt !== null && current.turnStartedAt === null
              ? { turnStartedAt: result.turnStartedAt }
              : {})
          }
        : {})
    }))
  }
})

// A turn that concludes — a terminal frame, a failed submit, reconciliation
// deciding it is gone — has nothing left to recover. Clearing here rather than
// only on the busy edge means an interrupted turn releases its entry too.
observeTurnLifecycle(({ key, turn }) => {
  if (turn && turn.phase !== 'settled') {
    return
  }

  const storedSessionId = $sessionStates.get()[key]?.storedSessionId

  if (storedSessionId) {
    clearInFlightTurnJournal(storedSessionId)
  }
})
