import { isGatewayReauthRequired, isGatewaySignInBusy, isGatewaySignInRequired } from '@/gateway'
import type { AllrWorkErrorKind } from '@/lib/allr-work'
import { atom } from '@/store/atom'

// The Allr Work card's sign-in state (ALLR-51), as a LEAF: it imports nothing from the
// connection stores. store/connection.ts has to clear it (on a successful Allr connect and
// on sign-out) and store/gateway-restore.ts has to set it (when a restore gives up), while
// store/allr-work.ts — which orchestrates the sign-in — imports both of those. Keeping the
// atoms here is what lets all three touch them without an import cycle.
//
// None of this is connection state. `$connection`, `$connectionPhase`, `$gatewayState`,
// `$hasConnected`, `$gatewaySwitching` and `$restoring` still say what the socket is doing;
// these only say what the Allr Work card should offer.

/** The last Allr Work sign-in failure, for the card. `cancelled` is never stored. */
export interface AllrWorkFailure {
  kind: AllrWorkErrorKind
  message: string
  /** The workspace hop 1 found, when the failure came after it. */
  workspace?: null | string
}

export const $allrWorkError = atom<AllrWorkFailure | null>(null)

/**
 * True while `signInToAllrWork` runs (the Rust sign-in and the connect after it). Guards
 * re-entry and drives the card's busy state on desktop. Not persisted: on mobile the JS
 * context that set it does not survive the sign-in.
 */
export const $allrWorkSignInFlight = atom(false)

/**
 * Why a boot restore of an `allr` target gave up, when it did — the card's cue to offer
 * **Sign in again** (design §5.6).
 *
 *  - `session-ended` — the workspace answered and there is no usable credential (the
 *    refresh token was refused, or the saved target is not a workspace this build accepts).
 *    Sign in is the only thing that helps.
 *  - `unreachable` — every attempt failed as "could not tell". Usually the network, but on
 *    an Allr workspace it is ALSO what an invalid-but-unexpired bearer looks like (the
 *    gateway answers 503, not 401), so the card offers Sign in again beside Try again
 *    rather than trusting the retry to ever work.
 */
export type AllrWorkRestoreIssue = 'session-ended' | 'unreachable'

export const $allrWorkRestoreIssue = atom<AllrWorkRestoreIssue | null>(null)

/** Classify the error an `allr` restore ended on. `null` for a sign-in that is already
 *  running elsewhere — that one finishes on its own and needs no CTA. Pure. */
export function allrWorkRestoreIssueFor(err: unknown): AllrWorkRestoreIssue | null {
  if (isGatewaySignInBusy(err)) {
    return null
  }

  if (isGatewaySignInRequired(err) || isGatewayReauthRequired(err)) {
    return 'session-ended'
  }

  return 'unreachable'
}

/** Forget everything the card was warning about: a connect landed, or the user signed out. */
export function clearAllrWorkNotices(): void {
  $allrWorkError.set(null)
  $allrWorkRestoreIssue.set(null)
}
