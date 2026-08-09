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
import { $sessionStates, addSessionKeyHooks, isPlaceholderKey, updateSession } from '@/store/session-state-types'
import { observeTurnLifecycle } from '@/store/turn-lifecycle'

// Sessions this process has already offered a recovery to. A session that
// rekeys twice (a resume that rotated the runtime id again) must not re-inject
// a tail the first recovery already merged.
const recovered = new Set<string>()

$sessionStates.subscribe(states => {
  for (const [, state] of Object.entries(states)) {
    if (state.storedSessionId) {
      persistInFlightTurnState({
        busy: state.busy,
        messages: state.messages,
        storedSessionId: state.storedSessionId,
        turnStartedAt: state.turnStartedAt
      })
    }
  }
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

    const result = alreadyRecovered
      ? { applied: false, messages: reconciled, turnStartedAt: null }
      : recoverInFlightTurnJournal(storedSessionId, reconciled)

    const messages = result.applied ? result.messages : reconciled

    if (messages === state.messages) {
      return
    }

    updateSession(toKey, current => ({
      ...current,
      messages,
      ...(result.turnStartedAt !== null && current.turnStartedAt === null
        ? { turnStartedAt: result.turnStartedAt }
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
