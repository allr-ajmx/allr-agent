/**
 * LIVENESS FOR SESSIONS THIS CLIENT HAS NEVER OPENED — a LEAF module, so both
 * the producer (`store/live-session-status.ts`, which pulls
 * `session.active_list`) and the consumers (`store/session.ts`'s sidebar
 * projections) can read it without closing a cycle.
 *
 * WHY IT IS NOT A SESSION SLICE. The snapshot's job is to light up a row for a
 * session running somewhere else — a cron tick, an inbound messaging turn, the
 * TUI, or the crash continuation the gateway scheduled while this app was dead.
 * That used to be done by publishing a `$sessionStates` slice for the stranger,
 * seeded from the snapshot alone: no transcript, no `session.resume`, no
 * transport bound to this webview.
 *
 * That slice was indistinguishable from a hydrated one. It carried a
 * `storedSessionId`, so `publishSessionState` indexed it, so
 * `runtimeKeyForStoredSession` resolved to it — and BOTH warm short-circuits
 * (`store/session.ts#openSession` and the tile delegate's
 * `resumeSessionToState`) take a resolved key as "this conversation is already
 * whole, there is nothing to fetch". Opening such a session therefore adopted an
 * EMPTY slice: no transcript, no runtime binding, no `hydrating: → runtime`
 * rekey — and so none of what that rekey is the seam for (live-tail
 * reconciliation, crash-journal recovery, `adoptResumedTurn` putting the session
 * into `$inflightTurns` where reconnect reconciliation can find it).
 *
 * The case where the gateway reports a session live and the app has no slice for
 * it is, by construction, the case right after a crash — which is exactly the
 * case MJXHRM-356's crash recovery exists for. So the stub defeated the feature
 * precisely when it was needed.
 *
 * Liveness is a projection, not a session. It lives here.
 */

import { atom } from 'nanostores'

/** What the gateway's registry says a session is doing. `waiting` implies
 *  working: a session parked on a clarify still owns a live turn. */
export type LiveSessionStatus = 'waiting' | 'working'

/** Stored session id → status, unioned across profiles. Only sessions with NO
 *  local slice matter to consumers; the slice answers for itself when there is
 *  one (and answers FASTER — it settles on the terminal frame, where the
 *  snapshot trails by a poll interval). */
export const $liveSessionStatuses = atom<Record<string, LiveSessionStatus>>({})

// Per profile, so one gateway's snapshot can never darken another's rows — the
// same scoping `liveRuntimesByProfile` applies to the reap.
const byProfile = new Map<string, Record<string, LiveSessionStatus>>()

function republish(): void {
  const next: Record<string, LiveSessionStatus> = {}

  for (const statuses of byProfile.values()) {
    for (const [storedSessionId, status] of Object.entries(statuses)) {
      // `waiting` wins: it is the one that also raises the attention dot.
      if (status === 'waiting' || !next[storedSessionId]) {
        next[storedSessionId] = status
      }
    }
  }

  const current = $liveSessionStatuses.get()
  const keys = Object.keys(next)

  // The snapshot re-publishes on every poll and every `sessions.changed` tick;
  // an unchanged map must not notify, or the sidebar repaints on a timer.
  if (keys.length === Object.keys(current).length && keys.every(key => current[key] === next[key])) {
    return
  }

  $liveSessionStatuses.set(next)
}

/**
 * Replace one profile's live set. Returns the stored ids that were live in the
 * previous snapshot for this profile and are not in this one — the sessions
 * whose turn ENDED while nothing local was watching, which is the edge the
 * sidebar's "your turn" dot hangs off.
 */
export function setLiveSessionStatuses(
  profileKey: string,
  statuses: Record<string, LiveSessionStatus>
): readonly string[] {
  const previous = byProfile.get(profileKey)
  byProfile.set(profileKey, statuses)
  republish()

  if (!previous) {
    return []
  }

  return Object.keys(previous).filter(storedSessionId => !(storedSessionId in statuses))
}

/** Forget every profile's liveness. A gateway wipe / profile switch invalidates
 *  it wholesale: the next snapshot is the only thing that may re-assert it. */
export function clearLiveSessionStatuses(): void {
  if (byProfile.size === 0) {
    return
  }

  byProfile.clear()
  republish()
}
