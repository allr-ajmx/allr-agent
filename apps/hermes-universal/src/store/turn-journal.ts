/**
 * Wires the crash journal (`lib/inflight-turn-journal.ts`) to the session store.
 *
 * Two seams, both owned by the store layer rather than by any one screen:
 *
 *  - WRITE: every republish of `$sessionStates` offers the busy sessions to the
 *    journal, which throttles the actual storage write. Subscribing rather than
 *    calling from the submit path is what makes it cover the whole turn, tool
 *    rows and all, instead of just the prompt.
 *  - READ: a session recovers its journal the moment it binds a hydrated
 *    transcript onto its runtime id (`rekeySession`). That is exactly the
 *    instant a cold open has the backend's answer and not yet any live events,
 *    so folding the journal in there cannot race a delta.
 */

import {
  clearInFlightTurnJournal,
  persistInFlightTurnState,
  recoverInFlightTurnJournal
} from '@/lib/inflight-turn-journal'
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
  rekey: (fromKey, toKey) => {
    // Only a HYDRATING key binding its runtime id is a cold open. A draft
    // promoting to a real session has no stored id to have journaled under, and
    // a live rekey is carrying a turn we are already streaming.
    if (!isPlaceholderKey(fromKey) || isPlaceholderKey(toKey)) {
      return
    }

    const state = $sessionStates.get()[toKey]
    const storedSessionId = state?.storedSessionId

    if (!state || !storedSessionId || recovered.has(storedSessionId)) {
      return
    }

    recovered.add(storedSessionId)
    const result = recoverInFlightTurnJournal(storedSessionId, state.messages)

    if (result.applied) {
      updateSession(toKey, current => ({
        ...current,
        messages: result.messages,
        ...(result.turnStartedAt !== null && current.turnStartedAt === null
          ? { turnStartedAt: result.turnStartedAt }
          : {})
      }))
    }
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
