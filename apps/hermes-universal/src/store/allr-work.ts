import { GatewaySignInBusyError } from '@/gateway'
import {
  allrWorkClearSession,
  type AllrWorkError,
  AllrWorkInvokeError,
  allrWorkSignIn,
  allrWorkTakeOutcome,
  isAllrWorkError,
  isAllrWorkSignInInFlight
} from '@/lib/allr-work'
import { oauthLogout } from '@/lib/auth'
import { IS_NATIVE_MOBILE } from '@/lib/platform'
import {
  $allrWorkError,
  $allrWorkRestoreIssue,
  $allrWorkResume,
  $allrWorkSignInFlight,
  allrWorkRestoreIssueFor,
  clearAllrWorkNotices
} from '@/store/allr-work-state'
import { connect } from '@/store/connection'
import {
  clearPendingAllr,
  clearPendingOAuth,
  currentAllrWorkspace,
  dialWithRestoreLadder,
  hasPendingAllr,
  hasPendingOAuth,
  loadGatewayTarget,
  savePendingAllr,
  takePendingAllr
} from '@/store/gateway-restore'
import { $gatewayMode } from '@/store/gateway-switch'
import { broadcastGatewaySwitch } from '@/store/gateway-switch-broadcast'

// Allr Work sign-in orchestration (ALLR-51). Rust runs the sign-in itself — portal
// hand-off, workspace validation, preflight, RFC 8252 token exchange — and answers with a
// workspace base (lib/allr-work.ts). This store turns that into a connection: connect
// afterwards, park and collect the mobile resume, switch account, and keep the card's error.
//
// The two platforms differ in one way that shapes everything here. Desktop signs in in a
// separate window and the command simply resolves. Android and iOS drive the CALLING
// webview through both hops (neither can host a dismissable second window), which destroys
// this JS context; Rust parks the result in a take-once mailbox before navigating back, and
// the reloaded SPA collects it in `resumeAllrSignIn`. Which path runs is `IS_NATIVE_MOBILE`
// — the same flag `beginOAuthLogin` and `cloudSignIn` use for the same one-way door.

export {
  $allrWorkError,
  $allrWorkRestoreIssue,
  $allrWorkResume,
  $allrWorkSignInFlight,
  type AllrWorkFailure,
  type AllrWorkRestoreIssue,
  type AllrWorkResume
} from '@/store/allr-work-state'

const busy = () => new GatewaySignInBusyError('An Allr Work sign-in is already in progress')

/** Put a Rust failure on the card. A cancellation is the user's choice, not a failure: silent. */
function reportFailure(error: AllrWorkError, workspace?: null | string): void {
  if (error.kind === 'cancelled') {
    return
  }

  $allrWorkError.set({ kind: error.kind, message: error.message, workspace: workspace ?? null })
}

/**
 * Run the Rust sign-in and hand back the workspace it signed in to.
 *
 * Mobile marker discipline, which mirrors `beginOAuthLogin` (store/connection.ts):
 *  - the marker is parked BEFORE the invoke, because the invoke is what destroys us;
 *  - a REJECTION means the app was never left (Rust refused before or at the first
 *    navigation), so a marker THIS call parked is garbage — cleared, and any outcome sitting
 *    in the mailbox is stale by definition and discarded, so a later resume cannot act on it;
 *  - `busy` is NOT a rejection: another sign-in owns the surface and has already navigated.
 *    If that one is an Allr Work sign-in it parked the marker first, and the marker is the
 *    only thing that will finish it after the reload — left alone. If this call parked it,
 *    the owner is some other flow (a remote OAuth sign-in, with its own marker), and ours
 *    would hijack that flow's reload into an Allr Work resume — so it goes.
 *
 * `switchAccount` goes to Rust as it is: see {@link allrWorkSignIn}.
 */
async function runRustSignIn(switchAccount: boolean): Promise<string> {
  // Whether the marker is ours to remove. Read before parking it.
  const parkedHere = IS_NATIVE_MOBILE && !hasPendingAllr()

  if (IS_NATIVE_MOBILE) {
    savePendingAllr()
  }

  let reply

  try {
    reply = await allrWorkSignIn({ switchAccount })
  } catch (err) {
    if (IS_NATIVE_MOBILE) {
      if (parkedHere) {
        clearPendingAllr()
      }

      await allrWorkTakeOutcome().catch(() => null)
    }

    if (isAllrWorkError(err)) {
      reportFailure(err)
    }

    throw err
  }

  if (reply.busy) {
    if (parkedHere) {
      clearPendingAllr()
    }

    throw busy()
  }

  if (IS_NATIVE_MOBILE) {
    // Still alive after a mobile sign-in, so the reply is the result and the parked copy of
    // it would make the next boot connect a second time.
    clearPendingAllr()
    await allrWorkTakeOutcome().catch(() => null)
  }

  if (!reply.workspace) {
    const error = new AllrWorkInvokeError('invalid-workspace', 'Allr Work did not name a workspace.')

    reportFailure(error)

    throw error
  }

  return reply.workspace
}

/**
 * Sign in to Allr Work and connect to the workspace it finds.
 *
 * Throws on every failure — including a cancellation — because it runs inside
 * `softSwitchGateway`, which reads a clean return as "the switch worked". A cancellation
 * rejects with the `cancelled` AllrWorkError and leaves `$allrWorkError` untouched; callers
 * that toast should skip it (`isAllrWorkCancelled`). A second call while one is running
 * throws `GatewaySignInBusyError` without touching Rust.
 *
 * On mobile this normally never settles: see `resumeAllrSignIn`.
 *
 * `switchAccount` is for {@link switchAllrWorkAccount} only: it asks the desktop sign-in window
 * for Google's account chooser. The card's own Sign in leaves it off.
 */
export async function signInToAllrWork(options: { switchAccount?: boolean } = {}): Promise<void> {
  if ($allrWorkSignInFlight.get() || isAllrWorkSignInInFlight()) {
    throw busy()
  }

  $allrWorkSignInFlight.set(true)
  clearAllrWorkNotices()

  try {
    const workspace = await runRustSignIn(options.switchAccount === true)

    await connect({ url: workspace, mode: 'allr' })
  } finally {
    $allrWorkSignInFlight.set(false)
  }
}

/**
 * Sign out of the current Allr Work account and sign in again, so a different one can be
 * picked: revoke the gateway session, forget the browser session (portal / Pomerium / Dex
 * cookies — otherwise hop 1 silently reuses the same account), then sign in.
 *
 * Google holds a session of its own, and would sign the same Google account straight back in.
 * So both Rust calls are told this is a switch (`switchAccount: true`): desktop's sign-in
 * window asks Google for its account chooser, and on a phone the clear also forgets Google's
 * sign-in cookies.
 *
 * The first two are best-effort: a user who asked to switch should still reach the sign-in.
 * The workspace comes from `currentAllrWorkspace` (validated); when there is none the
 * cookies under the parent domain are still cleared (`workspace: null`), because a clear
 * that names an invalid workspace is refused whole — and hop 1 would then silently reuse
 * the same account. Refuses up front while a sign-in is running: the clear takes no lease.
 */
export async function switchAllrWorkAccount(): Promise<void> {
  if ($allrWorkSignInFlight.get() || isAllrWorkSignInInFlight()) {
    throw busy()
  }

  const workspace = await currentAllrWorkspace()

  if (workspace) {
    await oauthLogout(workspace).catch(() => {})
  }

  await allrWorkClearSession({ workspace, switchAccount: true }).catch(() => {})
  await signInToAllrWork({ switchAccount: true })
}

/**
 * **Try again** after a restore that could not reach the workspace (`$allrWorkRestoreIssue`
 * `unreachable`): re-dial the workspace with the credential already in the keyring, once — a
 * person pressed the button, so no retry ladder.
 *
 * The workspace is the one a mobile resume signed in to and then failed to reach, when that is
 * what the card is about (`$allrWorkResume` `failed` — Rust validated it, and the saved target
 * is still the gateway from before the sign-in). Otherwise `currentAllrWorkspace`'s
 * (validated). When there is neither, there is nothing to re-dial, and a sign-in is the only
 * way back. A failure re-classifies the card's CTA from what it
 * failed with (a credential refused this time is `session-ended`), then re-throws for the
 * soft switch. A success clears the notice in `connect`.
 */
export async function reconnectAllrWork(): Promise<void> {
  if ($allrWorkSignInFlight.get() || isAllrWorkSignInInFlight()) {
    throw busy()
  }

  const resumed = $allrWorkResume.get()
  const workspace = resumed?.phase === 'failed' ? resumed.workspace : await currentAllrWorkspace()

  if (!workspace) {
    await signInToAllrWork()

    return
  }

  try {
    await connect({ url: workspace, mode: 'allr' })
  } catch (err) {
    $allrWorkRestoreIssue.set(allrWorkRestoreIssueFor(err))

    throw err
  }
}

/**
 * Finish a mobile Allr Work sign-in that came back through a page reload. Called by the
 * boot restore (`autoRestoreConnection`) before anything else.
 *
 * Resolves `true` when it decided where the boot lands, `false` when the boot should carry
 * on with the ordinary restore (no marker, or a sign-in that simply did not happen).
 *
 * One-shot twice over: the marker is taken synchronously before the first await, and
 * Rust's mailbox is take-once.
 *
 *  - `signed-in` → connect in allr mode (on the restore ladder), then tell every other
 *    WebView (only this one reloaded). `true`.
 *  - `failed` with a real failure → the Allr Work card shows it; never dials. `true`.
 *  - `failed(cancelled)`, or nothing parked → the user backed out (or the process died
 *    mid-flow, or the SPA reloaded a moment BEFORE Rust parked its `cancelled`). Nothing
 *    went wrong, so nothing is shown, and the boot goes back to where the user was — the
 *    gateway saved before the attempt, re-dialled non-interactively by the ordinary
 *    restore, exactly like the OAuth resume's fallback. That target is still there: an
 *    Allr Work sign-in saves its own only once its connect succeeds. `false`. A pending OAuth
 *    resume also returns `false`, so it runs. With neither there is nowhere to go back to,
 *    so the boot lands idle on the Allr Work card. `true`.
 *
 * A late `cancelled` read by some later resume takes the same silent fallback, so it can
 * never connect to a workspace or put anything on the card.
 */
export async function resumeAllrSignIn(): Promise<boolean> {
  if (!takePendingAllr()) {
    return false
  }

  // Synchronously, with the marker: the connecting screen stops seeing the marker right here.
  $allrWorkResume.set({ phase: 'pending' })

  const outcome = await allrWorkTakeOutcome().catch(() => null)

  if (outcome?.kind !== 'signed-in' || !outcome.workspace) {
    $allrWorkResume.set(null)
  }

  if (outcome?.kind === 'failed' && outcome.error?.kind !== 'cancelled') {
    $gatewayMode.set('allr')
    reportFailure(outcome.error, outcome.workspace)

    return true
  }

  if (outcome?.kind !== 'signed-in' || !outcome.workspace) {
    // Backed out (or nothing to show for it): fall back like the OAuth resume. A pending OAuth
    // resume is somewhere to go back to as well — it is the sign-in that owned the surface
    // when this one got `busy`, and it may have completed.
    if (loadGatewayTarget() || hasPendingOAuth()) {
      return false
    }

    $gatewayMode.set('allr')

    return true
  }

  $gatewayMode.set('allr')
  // This sign-in owned the surface, so an OAuth marker left beside it belongs to a sign-in
  // that got `busy` and never ran. Left in place it would fire on some later launch and pull
  // the user off this workspace.
  clearPendingOAuth()

  // The same bounded ladder as any boot restore: the signed-in credential is in the keyring,
  // and the radio / DNS / gateway being slow at launch is no reason to drop it on the card.
  const workspace = outcome.workspace

  $allrWorkResume.set({ phase: 'dialing', workspace })

  const lastError = await dialWithRestoreLadder(() => connect({ url: workspace, mode: 'allr' }))

  if (lastError !== null) {
    // connect() already set $connectionError + phase. The card still needs its CTA, and the
    // stopped screen the workspace it could not reach.
    $allrWorkResume.set({ phase: 'failed', workspace })
    $allrWorkRestoreIssue.set(allrWorkRestoreIssueFor(lastError))

    return true
  }

  // Resumed. (A successful connect clears it too; this does not depend on that.)
  $allrWorkResume.set(null)

  const target = loadGatewayTarget()

  if (target) {
    broadcastGatewaySwitch('allr', target)
  }

  return true
}
