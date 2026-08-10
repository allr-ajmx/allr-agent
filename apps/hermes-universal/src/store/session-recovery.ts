/**
 * ONE resolver for "the runtime session id I hold is dead."
 *
 * The gateway hands out a RUNTIME session id when a session resumes, and drops
 * it whenever its in-memory runtime goes away — sleep/wake, a backend restart, a
 * long idle. The stored session survives; the id we are holding does not. Every
 * session-scoped RPC hits this, not just `prompt.submit`: attach, `/compress`,
 * checkpoint restore and interrupt all run against the same id, and each one
 * that recovered on its own recovered slightly differently. Upstream consolidated
 * the whole bug class into a single wrapper (`fab99e828a`) and this is its shape.
 *
 * Two things make it correct rather than merely retrying:
 *
 *  - The resume goes out on the session's OWNING PROFILE. A resume without one
 *    lands on whichever gateway happens to be live and forks the conversation
 *    into the wrong profile's database. The probe stays gated on
 *    `sessionProfileIsAmbiguous()`, exactly as `openSession` does — see the note
 *    on `resumeStoredRuntimeSession`.
 *  - The retry is bounded to ONE attempt, and a caller may veto it after the
 *    resume lands (`driftReason`): the resume is the slow await, and the user can
 *    switch profile or chat during it. Landing the retry then would run the call
 *    against a session they are no longer looking at.
 */

import { requestGateway } from '@/store/gateway'
import { knownSessionProfile, resolveSessionProfile, sessionProfileIsAmbiguous } from '@/store/session'
import { aliasStoredSessionId } from '@/store/session-state-types'

/** Does this rejection mean "that runtime id no longer exists"? The gateway
 *  answers a dead runtime with a plain message, so this is a text test. */
export function isSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /session not found/i.test(message)
}

/** The gateway rejects a starved event loop with a timeout that is
 *  indistinguishable from a dead runtime on this side. Opt-in per caller
 *  (`alsoTimeout`): a submit should recover from it; a compress retry should not
 *  mask a genuinely slow LLM-bound call by firing it twice. */
export function isGatewayTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /request timed out/i.test(message)
}

/**
 * Thrown when a recovery resumed successfully but the caller's drift check says
 * the user has since moved on. The retry is deliberately NOT attempted; callers
 * unwind through their own abort path. The recovered id is carried so a caller
 * can still record the fresh binding.
 */
export class SessionRecoveryAborted extends Error {
  constructor(
    readonly reason: string,
    readonly recoveredSessionId: string
  ) {
    super(`session recovery aborted: ${reason}`)
    this.name = 'SessionRecoveryAborted'
  }
}

export interface SessionRecoveryDeps {
  /** Publish the fresh live id. The default aliases the stored id onto the live
   *  session's state key so every surface reading through the index follows;
   *  a caller holding its own hot ref must update that too, or the ref and the
   *  atom point at different runtimes. */
  onRecovered?: (liveSessionId: string) => void
  /** Non-null reason ⇒ abort instead of retrying. Evaluated AFTER the resume and
   *  BEFORE the retry, because the resume is the slow await. */
  driftReason?: () => null | string
}

/**
 * Re-register a durable stored session after the gateway dropped its in-memory
 * runtime id. Returns the fresh live id, or null when the resume yields none.
 *
 * `omit_messages` because this is a REBIND, not an open: the transcript is
 * already on screen and re-fetching it would repaint the chat mid-action.
 *
 * The profile probe is gated on `sessionProfileIsAmbiguous()` for the reason
 * recorded on MJXHRM-81: awaiting a resolution unconditionally defers the
 * resume by a microtask, which is long enough for a concurrent open to overtake
 * it. A single-profile install and an already-stamped row both answer
 * synchronously, so the resume still goes out in the same tick.
 */
export async function resumeStoredRuntimeSession(storedSessionId: string): Promise<null | string> {
  const known = knownSessionProfile(storedSessionId)
  const profile = known ?? (sessionProfileIsAmbiguous() ? await resolveSessionProfile(storedSessionId) : undefined)

  const resumed = await requestGateway<{ session_id?: string }>('session.resume', {
    session_id: storedSessionId,
    omit_messages: true,
    ...(profile ? { profile } : {})
  })

  return resumed?.session_id ?? null
}

/**
 * Run `call(sessionId)`. On a stale-session rejection, resume the stored session
 * ONCE, republish the fresh id, and retry. A second failure is a real error, not
 * a stale binding.
 *
 * A resume that itself fails rethrows the ORIGINAL error rather than the
 * confusing secondary one — a never-persisted draft has no row to resume, and
 * "session not found" describes that better than whatever the resume said.
 */
export async function withSessionNotFoundResume<T>(
  sessionId: string,
  storedSessionId: null | string | undefined,
  call: (liveSessionId: string) => Promise<T>,
  deps: SessionRecoveryDeps = {},
  options?: { alsoTimeout?: boolean }
): Promise<{ recovered: boolean; result: T; sessionId: string }> {
  try {
    return { recovered: false, result: await call(sessionId), sessionId }
  } catch (err) {
    const recoverable = isSessionNotFoundError(err) || (Boolean(options?.alsoTimeout) && isGatewayTimeoutError(err))

    if (!recoverable || !storedSessionId) {
      throw err
    }

    let recoveredId: null | string

    try {
      recoveredId = await resumeStoredRuntimeSession(storedSessionId)
    } catch {
      throw err
    }

    if (!recoveredId) {
      throw err
    }

    const drift = deps.driftReason?.()

    if (drift) {
      throw new SessionRecoveryAborted(drift, recoveredId)
    }

    // Default publish: point the stored id at the live session's slice so the
    // state map, and everything reading through it, follows the new runtime.
    ;(deps.onRecovered ?? (live => aliasStoredSessionId(storedSessionId, live)))(recoveredId)

    return { recovered: true, result: await call(recoveredId), sessionId: recoveredId }
  }
}
